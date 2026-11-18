//! 发邮件的两种实现：通过邮件服务发出去；或者写成文件，开发和测试时从那里看。

use std::path::{Path, PathBuf};

use async_trait::async_trait;
use lettre::message::Mailbox;
use lettre::message::header::ContentType;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use vibechat_core::StoreError;
use vibechat_core::mail::{Mail, Mailer};

fn failed(what: &str, err: impl std::fmt::Display) -> StoreError {
    StoreError::Unavailable(format!("{what}: {err}"))
}

/// 通过配置的邮件服务发送。
pub struct SmtpMailer {
    transport: AsyncSmtpTransport<Tokio1Executor>,
    from: Mailbox,
}

impl SmtpMailer {
    /// `url` 形如 `smtps://用户:密码@主机:465` 或 `smtp://主机:587?tls=required`；
    /// `from` 是发件人，形如 `VibeChat <no-reply@example.com>`。
    pub fn new(url: &str, from: &str) -> Result<Self, StoreError> {
        let transport = AsyncSmtpTransport::<Tokio1Executor>::from_url(url)
            // 地址里可能带着密码，不把它写进错误信息
            .map_err(|_| failed("SMTP_URL", "not a valid smtp:// or smtps:// address"))?
            .build();
        let from = from.parse().map_err(|err| failed("MAIL_FROM", err))?;
        Ok(Self { transport, from })
    }
}

#[async_trait]
impl Mailer for SmtpMailer {
    async fn send(&self, mail: &Mail) -> Result<(), StoreError> {
        let to: Mailbox = mail
            .to
            .parse()
            .map_err(|err| failed("recipient address", err))?;
        let message = Message::builder()
            .from(self.from.clone())
            .to(to)
            .subject(mail.subject.as_str())
            .header(ContentType::TEXT_PLAIN)
            .body(mail.body.clone())
            .map_err(|err| failed("building the message", err))?;
        self.transport
            .send(message)
            .await
            .map_err(|err| failed("sending mail", err))?;
        Ok(())
    }
}

/// 不发出去，每一封写成目录里的一个文件。没有配置邮件服务时用它。
pub struct FileMailer {
    dir: PathBuf,
}

impl FileMailer {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }
}

#[async_trait]
impl Mailer for FileMailer {
    async fn send(&self, mail: &Mail) -> Result<(), StoreError> {
        tokio::fs::create_dir_all(&self.dir)
            .await
            .map_err(|err| failed("creating the mail directory", err))?;
        // 文件名按时间排序：最新的一封排在最后
        let name = format!("{}.txt", uuid::Uuid::now_v7());
        let content = format!(
            "To: {}\nSubject: {}\n\n{}",
            mail.to, mail.subject, mail.body
        );
        // 先写到别的名字再改名：读的人不会看到写了一半的文件
        let partial = self.dir.join(format!(".{name}.part"));
        tokio::fs::write(&partial, content)
            .await
            .map_err(|err| failed("writing mail to a file", err))?;
        tokio::fs::rename(&partial, self.dir.join(&name))
            .await
            .map_err(|err| failed("writing mail to a file", err))?;
        Ok(())
    }
}
