//! `vibechat-core` 中各 trait 的具体实现。
//!
//! 所有与数据库、文件存储有关的代码只出现在这个 crate 里。

pub mod blob;
pub mod crypto;
pub mod db;
pub mod images;
pub mod mail;
