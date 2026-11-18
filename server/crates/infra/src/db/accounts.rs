//! 账号相关的四张表：用户、登录会话、邀请码、文件。

use std::str::FromStr;

use async_trait::async_trait;
use sea_orm::sea_query::{Expr, Func, Query};
use sea_orm::{
    ActiveValue::Set, ColumnTrait, Condition, DatabaseConnection, DbErr, EntityTrait, ExprTrait,
    Order, PaginatorTrait, QueryFilter, QueryOrder, QuerySelect, SqlErr, TransactionTrait,
};
use vibechat_core::account::handle::normalize;
use vibechat_core::account::model::{
    FilePurpose, InviteCode, InviteCodeOrder, InviteCodeQuery, InviteCodeState, InviteCodeStatus,
    Language, ProfileChanges, Role, Session, StoredFile, Theme, User, UserCounts, UserQuery,
    UserStatus,
};
use vibechat_core::account::store::{
    CreateUserError, FileStore, InviteCodeStore, SessionStore, UserStore,
};
use vibechat_core::{FileId, InviteCodeId, SessionId, StoreError, UserId};

use super::entities::{files, invite_codes, message_files, messages, sessions, users};
use super::{contains_pattern, corrupt, parse_id, unavailable};

pub struct DbAccounts {
    db: DatabaseConnection,
}

impl DbAccounts {
    pub fn new(db: DatabaseConnection) -> Self {
        Self { db }
    }
}

fn is_unique_violation(err: &DbErr) -> bool {
    matches!(err.sql_err(), Some(SqlErr::UniqueConstraintViolation(_)))
}

fn parse_optional_id<T: FromStr>(text: Option<&str>, what: &str) -> Result<Option<T>, StoreError> {
    text.map(|text| parse_id(text, what)).transpose()
}

fn user_from(row: users::Model) -> Result<User, StoreError> {
    Ok(User {
        id: parse_id(&row.id, "users.id")?,
        handle: row.handle,
        nickname: row.nickname,
        signature: row.signature,
        avatar: parse_optional_id(row.avatar_file_id.as_deref(), "users.avatar_file_id")?,
        password_hash: row.password_hash,
        role: Role::parse(&row.role).ok_or_else(|| corrupt("users.role"))?,
        status: UserStatus::parse(&row.status).ok_or_else(|| corrupt("users.status"))?,
        must_change_password: row.must_change_password,
        email: row.email,
        // 认不出的取值当作没有选择过，由客户端按默认处理
        language: row.language.as_deref().and_then(Language::parse),
        theme: row.theme.as_deref().and_then(Theme::parse),
        created_at: row.created_at,
        last_login_at: row.last_login_at,
    })
}

fn user_row(user: &User, invite_code: Option<InviteCodeId>) -> users::ActiveModel {
    users::ActiveModel {
        id: Set(user.id.to_string()),
        handle: Set(user.handle.clone()),
        handle_lower: Set(normalize(&user.handle)),
        nickname: Set(user.nickname.clone()),
        signature: Set(user.signature.clone()),
        avatar_file_id: Set(user.avatar.map(|id| id.to_string())),
        password_hash: Set(user.password_hash.clone()),
        role: Set(user.role.as_str().to_owned()),
        status: Set(user.status.as_str().to_owned()),
        must_change_password: Set(user.must_change_password),
        email: Set(user.email.clone()),
        invite_code_id: Set(invite_code.map(|id| id.to_string())),
        language: Set(user.language.map(|v| v.as_str().to_owned())),
        theme: Set(user.theme.map(|v| v.as_str().to_owned())),
        created_at: Set(user.created_at),
        last_login_at: Set(user.last_login_at),
    }
}

fn session_from(row: sessions::Model) -> Result<Session, StoreError> {
    Ok(Session {
        id: parse_id(&row.id, "sessions.id")?,
        user_id: parse_id(&row.user_id, "sessions.user_id")?,
        token_hash: row.token_hash,
        created_at: row.created_at,
        last_seen_at: row.last_seen_at,
        expires_at: row.expires_at,
        user_agent: row.user_agent,
        ip: row.ip,
    })
}

fn invite_from(row: invite_codes::Model) -> Result<InviteCode, StoreError> {
    Ok(InviteCode {
        id: parse_id(&row.id, "invite_codes.id")?,
        code: row.code,
        note: row.note,
        status: InviteCodeStatus::parse(&row.status)
            .ok_or_else(|| corrupt("invite_codes.status"))?,
        expires_at: row.expires_at,
        created_by: parse_id(&row.created_by, "invite_codes.created_by")?,
        created_at: row.created_at,
        used_by: parse_optional_id(row.used_by.as_deref(), "invite_codes.used_by")?,
        used_at: row.used_at,
    })
}

fn file_from(row: files::Model) -> Result<StoredFile, StoreError> {
    Ok(StoredFile {
        id: parse_id(&row.id, "files.id")?,
        storage_key: row.storage_key,
        content_type: row.content_type,
        size: row.size,
        uploader: parse_id(&row.uploader_id, "files.uploader_id")?,
        purpose: FilePurpose::parse(&row.purpose).ok_or_else(|| corrupt("files.purpose"))?,
        width: row.width,
        height: row.height,
        name: row.name,
        thumbnail_key: row.thumbnail_key,
        created_at: row.created_at,
    })
}

#[async_trait]
impl UserStore for DbAccounts {
    async fn create_with_invite(
        &self,
        user: &User,
        invite_code: InviteCodeId,
        now: i64,
    ) -> Result<(), CreateUserError> {
        let txn = self.db.begin().await.map_err(unavailable)?;

        // 只有仍然是"未使用"并且没有过期的邀请码才会被更新到。
        // 两个人同时注册时，数据库保证只有一个人的这条更新能改到这一行。
        let claimed = invite_codes::Entity::update_many()
            .col_expr(
                invite_codes::Column::Status,
                Expr::value(InviteCodeStatus::Used.as_str()),
            )
            .col_expr(
                invite_codes::Column::UsedBy,
                Expr::value(user.id.to_string()),
            )
            .col_expr(invite_codes::Column::UsedAt, Expr::value(now))
            .filter(invite_codes::Column::Id.eq(invite_code.to_string()))
            .filter(invite_codes::Column::Status.eq(InviteCodeStatus::Unused.as_str()))
            .filter(
                Condition::any()
                    .add(invite_codes::Column::ExpiresAt.is_null())
                    .add(invite_codes::Column::ExpiresAt.gt(now)),
            )
            .exec(&txn)
            .await
            .map_err(unavailable)?;
        if claimed.rows_affected != 1 {
            txn.rollback().await.map_err(unavailable)?;
            return Err(CreateUserError::InviteCodeUnavailable);
        }

        if let Err(err) = users::Entity::insert(user_row(user, Some(invite_code)))
            .exec_without_returning(&txn)
            .await
        {
            let taken = is_unique_violation(&err);
            txn.rollback().await.map_err(unavailable)?;
            return Err(if taken {
                CreateUserError::HandleTaken
            } else {
                unavailable(err).into()
            });
        }

        txn.commit().await.map_err(unavailable)?;
        Ok(())
    }

    async fn create_admin_if_none(&self, user: &User) -> Result<bool, StoreError> {
        let txn = self.db.begin().await.map_err(unavailable)?;
        let admins = users::Entity::find()
            .filter(users::Column::Role.eq(Role::Admin.as_str()))
            .count(&txn)
            .await
            .map_err(unavailable)?;
        if admins > 0 {
            txn.rollback().await.map_err(unavailable)?;
            return Ok(false);
        }
        users::Entity::insert(user_row(user, None))
            .exec_without_returning(&txn)
            .await
            .map_err(unavailable)?;
        txn.commit().await.map_err(unavailable)?;
        Ok(true)
    }

    async fn has_admin(&self) -> Result<bool, StoreError> {
        let admins = users::Entity::find()
            .filter(users::Column::Role.eq(Role::Admin.as_str()))
            .count(&self.db)
            .await
            .map_err(unavailable)?;
        Ok(admins > 0)
    }

    async fn find(&self, id: UserId) -> Result<Option<User>, StoreError> {
        users::Entity::find_by_id(id.to_string())
            .one(&self.db)
            .await
            .map_err(unavailable)?
            .map(user_from)
            .transpose()
    }

    async fn find_many(&self, ids: &[UserId]) -> Result<Vec<User>, StoreError> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        users::Entity::find()
            .filter(users::Column::Id.is_in(ids.iter().map(ToString::to_string)))
            .all(&self.db)
            .await
            .map_err(unavailable)?
            .into_iter()
            .map(user_from)
            .collect()
    }

    async fn find_by_handle(&self, handle: &str) -> Result<Option<User>, StoreError> {
        users::Entity::find()
            .filter(users::Column::HandleLower.eq(normalize(handle)))
            .one(&self.db)
            .await
            .map_err(unavailable)?
            .map(user_from)
            .transpose()
    }

    async fn set_handle(&self, id: UserId, handle: &str) -> Result<bool, StoreError> {
        let result = users::Entity::update_many()
            .col_expr(users::Column::Handle, Expr::value(handle))
            .col_expr(users::Column::HandleLower, Expr::value(normalize(handle)))
            .filter(users::Column::Id.eq(id.to_string()))
            .exec(&self.db)
            .await;
        match result {
            Ok(_) => Ok(true),
            Err(err) if is_unique_violation(&err) => Ok(false),
            Err(err) => Err(unavailable(err)),
        }
    }

    async fn set_password(
        &self,
        id: UserId,
        password_hash: &str,
        must_change_password: bool,
    ) -> Result<(), StoreError> {
        users::Entity::update_many()
            .col_expr(users::Column::PasswordHash, Expr::value(password_hash))
            .col_expr(
                users::Column::MustChangePassword,
                Expr::value(must_change_password),
            )
            .filter(users::Column::Id.eq(id.to_string()))
            .exec(&self.db)
            .await
            .map_err(unavailable)?;
        Ok(())
    }

    async fn update_profile(&self, id: UserId, changes: &ProfileChanges) -> Result<(), StoreError> {
        let mut update = users::Entity::update_many();
        let mut changed = false;
        if let Some(nickname) = &changes.nickname {
            update = update.col_expr(users::Column::Nickname, Expr::value(nickname.as_str()));
            changed = true;
        }
        if let Some(signature) = &changes.signature {
            update = update.col_expr(users::Column::Signature, Expr::value(signature.as_str()));
            changed = true;
        }
        if let Some(language) = changes.language {
            update = update.col_expr(users::Column::Language, Expr::value(language.as_str()));
            changed = true;
        }
        if let Some(theme) = changes.theme {
            update = update.col_expr(users::Column::Theme, Expr::value(theme.as_str()));
            changed = true;
        }
        if !changed {
            return Ok(());
        }
        update
            .filter(users::Column::Id.eq(id.to_string()))
            .exec(&self.db)
            .await
            .map_err(unavailable)?;
        Ok(())
    }

    async fn set_avatar(&self, id: UserId, file: FileId) -> Result<(), StoreError> {
        users::Entity::update_many()
            .col_expr(users::Column::AvatarFileId, Expr::value(file.to_string()))
            .filter(users::Column::Id.eq(id.to_string()))
            .exec(&self.db)
            .await
            .map_err(unavailable)?;
        Ok(())
    }

    async fn record_login(&self, id: UserId, now: i64) -> Result<(), StoreError> {
        users::Entity::update_many()
            .col_expr(users::Column::LastLoginAt, Expr::value(now))
            .filter(users::Column::Id.eq(id.to_string()))
            .exec(&self.db)
            .await
            .map_err(unavailable)?;
        Ok(())
    }

    async fn list(&self, query: &UserQuery) -> Result<(Vec<User>, u64), StoreError> {
        let mut filter = Condition::all();
        if let Some(status) = query.status {
            filter = filter.add(users::Column::Status.eq(status.as_str()));
        }
        if let Some(search) = &query.search {
            // 两边都转成小写再比：不区分大小写，在两种数据库上结果一样
            let nickname = Func::lower(Expr::col((users::Entity, users::Column::Nickname)));
            filter = filter.add(
                Condition::any()
                    .add(users::Column::HandleLower.like(contains_pattern(search)))
                    .add(Expr::expr(nickname).like(contains_pattern(search))),
            );
        }
        let total = users::Entity::find()
            .filter(filter.clone())
            .count(&self.db)
            .await
            .map_err(unavailable)?;
        let found = users::Entity::find()
            .filter(filter)
            .order_by_desc(users::Column::CreatedAt)
            .order_by_desc(users::Column::Id)
            .offset(query.offset)
            .limit(query.limit)
            .all(&self.db)
            .await
            .map_err(unavailable)?
            .into_iter()
            .map(user_from)
            .collect::<Result<Vec<_>, _>>()?;
        Ok((found, total))
    }

    async fn set_status(&self, id: UserId, status: UserStatus) -> Result<(), StoreError> {
        users::Entity::update_many()
            .col_expr(users::Column::Status, Expr::value(status.as_str()))
            .filter(users::Column::Id.eq(id.to_string()))
            .exec(&self.db)
            .await
            .map_err(unavailable)?;
        Ok(())
    }

    async fn counts(&self) -> Result<UserCounts, StoreError> {
        let total = users::Entity::find()
            .count(&self.db)
            .await
            .map_err(unavailable)?;
        let disabled = users::Entity::find()
            .filter(users::Column::Status.eq(UserStatus::Disabled.as_str()))
            .count(&self.db)
            .await
            .map_err(unavailable)?;
        Ok(UserCounts { total, disabled })
    }

    async fn find_admin(&self) -> Result<Option<User>, StoreError> {
        users::Entity::find()
            .filter(users::Column::Role.eq(Role::Admin.as_str()))
            .order_by_asc(users::Column::CreatedAt)
            .one(&self.db)
            .await
            .map_err(unavailable)?
            .map(user_from)
            .transpose()
    }

    async fn set_email(&self, id: UserId, email: &str) -> Result<(), StoreError> {
        users::Entity::update_many()
            .col_expr(users::Column::Email, Expr::value(email))
            .filter(users::Column::Id.eq(id.to_string()))
            .exec(&self.db)
            .await
            .map_err(unavailable)?;
        Ok(())
    }
}

#[async_trait]
impl SessionStore for DbAccounts {
    async fn create(&self, session: &Session) -> Result<(), StoreError> {
        let row = sessions::ActiveModel {
            id: Set(session.id.to_string()),
            user_id: Set(session.user_id.to_string()),
            token_hash: Set(session.token_hash.clone()),
            created_at: Set(session.created_at),
            last_seen_at: Set(session.last_seen_at),
            expires_at: Set(session.expires_at),
            user_agent: Set(session.user_agent.clone()),
            ip: Set(session.ip.clone()),
        };
        sessions::Entity::insert(row)
            .exec_without_returning(&self.db)
            .await
            .map_err(unavailable)?;
        Ok(())
    }

    async fn find_by_token_hash(&self, token_hash: &str) -> Result<Option<Session>, StoreError> {
        sessions::Entity::find()
            .filter(sessions::Column::TokenHash.eq(token_hash))
            .one(&self.db)
            .await
            .map_err(unavailable)?
            .map(session_from)
            .transpose()
    }

    async fn touch(
        &self,
        id: SessionId,
        last_seen_at: i64,
        expires_at: i64,
    ) -> Result<(), StoreError> {
        sessions::Entity::update_many()
            .col_expr(sessions::Column::LastSeenAt, Expr::value(last_seen_at))
            .col_expr(sessions::Column::ExpiresAt, Expr::value(expires_at))
            .filter(sessions::Column::Id.eq(id.to_string()))
            .exec(&self.db)
            .await
            .map_err(unavailable)?;
        Ok(())
    }

    async fn delete(&self, id: SessionId) -> Result<(), StoreError> {
        sessions::Entity::delete_by_id(id.to_string())
            .exec(&self.db)
            .await
            .map_err(unavailable)?;
        Ok(())
    }

    async fn list_for_user(&self, user: UserId, now: i64) -> Result<Vec<Session>, StoreError> {
        sessions::Entity::find()
            .filter(sessions::Column::UserId.eq(user.to_string()))
            .filter(sessions::Column::ExpiresAt.gt(now))
            .order_by_desc(sessions::Column::LastSeenAt)
            .all(&self.db)
            .await
            .map_err(unavailable)?
            .into_iter()
            .map(session_from)
            .collect()
    }

    async fn delete_for_user(&self, user: UserId, id: SessionId) -> Result<bool, StoreError> {
        let deleted = sessions::Entity::delete_many()
            .filter(sessions::Column::Id.eq(id.to_string()))
            .filter(sessions::Column::UserId.eq(user.to_string()))
            .exec(&self.db)
            .await
            .map_err(unavailable)?;
        Ok(deleted.rows_affected == 1)
    }

    async fn delete_others(
        &self,
        user: UserId,
        keep: Option<SessionId>,
    ) -> Result<Vec<SessionId>, StoreError> {
        let mut condition = Condition::all().add(sessions::Column::UserId.eq(user.to_string()));
        if let Some(keep) = keep {
            condition = condition.add(sessions::Column::Id.ne(keep.to_string()));
        }

        let txn = self.db.begin().await.map_err(unavailable)?;
        let rows = sessions::Entity::find()
            .filter(condition.clone())
            .all(&txn)
            .await
            .map_err(unavailable)?;
        sessions::Entity::delete_many()
            .filter(condition)
            .exec(&txn)
            .await
            .map_err(unavailable)?;
        txn.commit().await.map_err(unavailable)?;

        rows.iter()
            .map(|row| parse_id(&row.id, "sessions.id"))
            .collect()
    }
}

#[async_trait]
impl InviteCodeStore for DbAccounts {
    async fn create_many(&self, codes: &[InviteCode]) -> Result<(), StoreError> {
        if codes.is_empty() {
            return Ok(());
        }
        let rows = codes.iter().map(|invite| invite_codes::ActiveModel {
            id: Set(invite.id.to_string()),
            code: Set(invite.code.clone()),
            note: Set(invite.note.clone()),
            status: Set(invite.status.as_str().to_owned()),
            expires_at: Set(invite.expires_at),
            created_by: Set(invite.created_by.to_string()),
            created_at: Set(invite.created_at),
            used_by: Set(invite.used_by.map(|id| id.to_string())),
            used_at: Set(invite.used_at),
        });
        invite_codes::Entity::insert_many(rows)
            .exec_without_returning(&self.db)
            .await
            .map_err(unavailable)?;
        Ok(())
    }

    async fn find(&self, id: InviteCodeId) -> Result<Option<InviteCode>, StoreError> {
        invite_codes::Entity::find_by_id(id.to_string())
            .one(&self.db)
            .await
            .map_err(unavailable)?
            .map(invite_from)
            .transpose()
    }

    async fn find_many(&self, ids: &[InviteCodeId]) -> Result<Vec<InviteCode>, StoreError> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        invite_codes::Entity::find()
            .filter(invite_codes::Column::Id.is_in(ids.iter().map(ToString::to_string)))
            .all(&self.db)
            .await
            .map_err(unavailable)?
            .into_iter()
            .map(invite_from)
            .collect()
    }

    async fn find_used_by(&self, users: &[UserId]) -> Result<Vec<InviteCode>, StoreError> {
        if users.is_empty() {
            return Ok(Vec::new());
        }
        invite_codes::Entity::find()
            .filter(invite_codes::Column::UsedBy.is_in(users.iter().map(ToString::to_string)))
            .all(&self.db)
            .await
            .map_err(unavailable)?
            .into_iter()
            .map(invite_from)
            .collect()
    }

    async fn revoke(&self, ids: &[InviteCodeId]) -> Result<u64, StoreError> {
        // 只有仍然是"未使用"的才会被改到：正在被人用来注册的邀请码，
        // 要么先被注册用掉，要么先被作废，不会两头都成功
        let result = invite_codes::Entity::update_many()
            .col_expr(
                invite_codes::Column::Status,
                Expr::value(InviteCodeStatus::Revoked.as_str()),
            )
            .filter(invite_codes::Column::Id.is_in(ids.iter().map(ToString::to_string)))
            .filter(invite_codes::Column::Status.eq(InviteCodeStatus::Unused.as_str()))
            .exec(&self.db)
            .await
            .map_err(unavailable)?;
        Ok(result.rows_affected)
    }

    async fn find_by_code(&self, code: &str) -> Result<Option<InviteCode>, StoreError> {
        invite_codes::Entity::find()
            .filter(invite_codes::Column::Code.eq(code))
            .one(&self.db)
            .await
            .map_err(unavailable)?
            .map(invite_from)
            .transpose()
    }

    async fn delete_dead(&self, ids: &[InviteCodeId], now: i64) -> Result<u64, StoreError> {
        // 已经作废的，或者还没有使用但已经过了有效期的。没有有效期的不会过期
        let dead = Condition::any()
            .add(invite_codes::Column::Status.eq(InviteCodeStatus::Revoked.as_str()))
            .add(
                Condition::all()
                    .add(invite_codes::Column::Status.eq(InviteCodeStatus::Unused.as_str()))
                    .add(invite_codes::Column::ExpiresAt.lte(now)),
            );
        let result = invite_codes::Entity::delete_many()
            .filter(invite_codes::Column::Id.is_in(ids.iter().map(ToString::to_string)))
            .filter(dead)
            .exec(&self.db)
            .await
            .map_err(unavailable)?;
        Ok(result.rows_affected)
    }

    async fn list(&self, query: &InviteCodeQuery) -> Result<(Vec<InviteCode>, u64), StoreError> {
        let status = |status: InviteCodeStatus| invite_codes::Column::Status.eq(status.as_str());
        // "已过期"不单独保存：没有被使用、有有效期、并且已经到期
        let filter = match query.state {
            None => Condition::all(),
            Some(InviteCodeState::Used) => Condition::all().add(status(InviteCodeStatus::Used)),
            Some(InviteCodeState::Revoked) => {
                Condition::all().add(status(InviteCodeStatus::Revoked))
            }
            Some(InviteCodeState::Expired) => Condition::all()
                .add(status(InviteCodeStatus::Unused))
                .add(invite_codes::Column::ExpiresAt.lte(query.now)),
            Some(InviteCodeState::Unused) => {
                Condition::all().add(status(InviteCodeStatus::Unused)).add(
                    Condition::any()
                        .add(invite_codes::Column::ExpiresAt.is_null())
                        .add(invite_codes::Column::ExpiresAt.gt(query.now)),
                )
            }
        };
        let order = match query.order {
            InviteCodeOrder::NewestFirst => Order::Desc,
            InviteCodeOrder::OldestFirst => Order::Asc,
        };

        let total = invite_codes::Entity::find()
            .filter(filter.clone())
            .count(&self.db)
            .await
            .map_err(unavailable)?;
        let codes = invite_codes::Entity::find()
            .filter(filter)
            .order_by(invite_codes::Column::CreatedAt, order.clone())
            .order_by(invite_codes::Column::Id, order)
            .offset(query.offset)
            .limit(query.limit)
            .all(&self.db)
            .await
            .map_err(unavailable)?
            .into_iter()
            .map(invite_from)
            .collect::<Result<Vec<_>, _>>()?;
        Ok((codes, total))
    }
}

#[async_trait]
impl FileStore for DbAccounts {
    async fn create(&self, file: &StoredFile) -> Result<(), StoreError> {
        let row = files::ActiveModel {
            id: Set(file.id.to_string()),
            storage_key: Set(file.storage_key.clone()),
            content_type: Set(file.content_type.clone()),
            size: Set(file.size),
            uploader_id: Set(file.uploader.to_string()),
            purpose: Set(file.purpose.as_str().to_owned()),
            width: Set(file.width),
            height: Set(file.height),
            created_at: Set(file.created_at),
            name: Set(file.name.clone()),
            thumbnail_key: Set(file.thumbnail_key.clone()),
        };
        files::Entity::insert(row)
            .exec_without_returning(&self.db)
            .await
            .map_err(unavailable)?;
        Ok(())
    }

    async fn find(&self, id: FileId) -> Result<Option<StoredFile>, StoreError> {
        files::Entity::find_by_id(id.to_string())
            .one(&self.db)
            .await
            .map_err(unavailable)?
            .map(file_from)
            .transpose()
    }

    async fn find_many(&self, ids: &[FileId]) -> Result<Vec<StoredFile>, StoreError> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        files::Entity::find()
            .filter(files::Column::Id.is_in(ids.iter().map(ToString::to_string)))
            .all(&self.db)
            .await
            .map_err(unavailable)?
            .into_iter()
            .map(file_from)
            .collect()
    }

    async fn list_orphans(&self, before: i64) -> Result<Vec<StoredFile>, StoreError> {
        // 被消息引用了的文件
        let attached = Query::select()
            .column(messages::Column::FileId)
            .from(messages::Entity)
            .and_where(messages::Column::FileId.is_not_null())
            .to_owned();
        // 放进了聊天记录的文件
        let recorded = Query::select()
            .column(message_files::Column::FileId)
            .from(message_files::Entity)
            .to_owned();
        files::Entity::find()
            .filter(files::Column::Purpose.eq(FilePurpose::Attachment.as_str()))
            .filter(files::Column::CreatedAt.lt(before))
            .filter(files::Column::Id.not_in_subquery(attached))
            .filter(files::Column::Id.not_in_subquery(recorded))
            .all(&self.db)
            .await
            .map_err(unavailable)?
            .into_iter()
            .map(file_from)
            .collect()
    }

    async fn delete(&self, id: FileId) -> Result<(), StoreError> {
        files::Entity::delete_by_id(id.to_string())
            .exec(&self.db)
            .await
            .map_err(unavailable)?;
        Ok(())
    }

    async fn count_sharing(&self, storage_key: &str) -> Result<u64, StoreError> {
        files::Entity::find()
            .filter(files::Column::StorageKey.eq(storage_key))
            .count(&self.db)
            .await
            .map_err(unavailable)
    }

    async fn usage(&self) -> Result<(u64, u64), StoreError> {
        // 只取存储位置和大小，在这边加起来：求和的结果在两种数据库上类型不一样。
        // 转发出来的文件和原文件共用同一份内容，按存储位置只算一次
        let rows: Vec<(String, i64)> = files::Entity::find()
            .select_only()
            .column(files::Column::StorageKey)
            .column(files::Column::Size)
            .into_tuple()
            .all(&self.db)
            .await
            .map_err(unavailable)?;
        let distinct: std::collections::HashMap<String, i64> = rows.into_iter().collect();
        let bytes: i64 = distinct.values().sum();
        Ok((distinct.len() as u64, u64::try_from(bytes).unwrap_or(0)))
    }
}
