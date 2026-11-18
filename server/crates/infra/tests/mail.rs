//! 发邮件的两种实现：写成文件的，和通过邮件服务发的（对着一个假的邮件服务）。

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use vibechat_core::mail::{Mail, Mailer};
use vibechat_infra::mail::{FileMailer, SmtpMailer};

fn mail(to: &str, subject: &str, body: &str) -> Mail {
    Mail {
        to: to.to_owned(),
        subject: subject.to_owned(),
        body: body.to_owned(),
    }
}

#[tokio::test]
async fn without_a_mail_server_each_message_becomes_a_file() {
    let dir = tempfile::tempdir().unwrap();
    // 目录还不存在：第一次发的时候建
    let mailer = FileMailer::new(dir.path().join("outbox"));
    let first = mail(
        "boss@example.com",
        "重置密码",
        "链接：http://vibe.test/a?token=1\n",
    );
    let second = mail(
        "new@example.com",
        "确认邮箱",
        "链接：http://vibe.test/b?token=2\n",
    );
    mailer.send(&first).await.unwrap();
    mailer.send(&second).await.unwrap();

    let mut names: Vec<String> = std::fs::read_dir(mailer.dir())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    // 只有写完的文件，按文件名排就是发出的先后
    assert_eq!(names.len(), 2);
    assert!(names.iter().all(|name| name.ends_with(".txt")));
    let read = |name: &str| std::fs::read_to_string(mailer.dir().join(name)).unwrap();
    assert_eq!(
        read(&names[0]),
        "To: boss@example.com\nSubject: 重置密码\n\n链接：http://vibe.test/a?token=1\n"
    );
    assert!(read(&names[1]).starts_with("To: new@example.com\nSubject: 确认邮箱\n\n"));
}

/// 一封邮件在假的邮件服务那边看到的样子。
#[derive(Debug)]
struct Received {
    from: String,
    to: String,
    data: String,
}

/// 一个只会说最基本的 SMTP 的假邮件服务。返回它的地址，和它收到的邮件。
async fn fake_smtp() -> (String, mpsc::UnboundedReceiver<Received>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("smtp://{}", listener.local_addr().unwrap());
    let (sender, receiver) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let sender = sender.clone();
            tokio::spawn(async move {
                let (read, mut write) = stream.into_split();
                let mut lines = BufReader::new(read).lines();
                write.write_all(b"220 fake ESMTP\r\n").await.unwrap();
                let (mut from, mut to) = (String::new(), String::new());
                while let Ok(Some(line)) = lines.next_line().await {
                    let upper = line.to_ascii_uppercase();
                    let reply: &[u8] = if upper.starts_with("EHLO") {
                        b"250-fake\r\n250 8BITMIME\r\n"
                    } else if upper.starts_with("MAIL FROM:") {
                        from = line[10..].to_owned();
                        b"250 OK\r\n"
                    } else if upper.starts_with("RCPT TO:") {
                        to = line[8..].to_owned();
                        b"250 OK\r\n"
                    } else if upper.starts_with("DATA") {
                        write.write_all(b"354 go ahead\r\n").await.unwrap();
                        let mut data = String::new();
                        while let Ok(Some(line)) = lines.next_line().await {
                            if line == "." {
                                break;
                            }
                            data.push_str(&line);
                            data.push('\n');
                        }
                        let received = Received {
                            from: from.clone(),
                            to: to.clone(),
                            data,
                        };
                        let _ = sender.send(received);
                        b"250 queued\r\n"
                    } else if upper.starts_with("QUIT") {
                        let _ = write.write_all(b"221 bye\r\n").await;
                        break;
                    } else {
                        b"250 OK\r\n"
                    };
                    if write.write_all(reply).await.is_err() {
                        break;
                    }
                }
            });
        }
    });
    (url, receiver)
}

#[tokio::test]
async fn with_a_mail_server_the_message_is_delivered_over_smtp() {
    let (url, mut inbox) = fake_smtp().await;
    let mailer = SmtpMailer::new(&url, "VibeChat <no-reply@vibe.test>").unwrap();
    let link = "http://vibe.test/reset-password?token=abc123";
    let body = format!("Open this link to set a new password:\n\n{link}\n");
    mailer
        .send(&mail("boss@example.com", "Reset your password", &body))
        .await
        .unwrap();

    let received = inbox.recv().await.unwrap();
    assert!(received.from.contains("<no-reply@vibe.test>"));
    assert!(received.to.contains("<boss@example.com>"));
    assert!(received.data.contains("Subject: Reset your password"));
    assert!(received.data.contains("To: boss@example.com"));
    assert!(
        received
            .data
            .contains("From: VibeChat <no-reply@vibe.test>")
    );
    assert!(
        received
            .data
            .contains("Content-Type: text/plain; charset=utf-8")
    );
    assert!(received.data.contains(link));

    // 中文的标题和正文也发得出去
    let chinese = mail(
        "boss@example.com",
        "重置 VibeChat 的密码",
        "打开下面的链接。\n",
    );
    mailer.send(&chinese).await.unwrap();
    let received = inbox.recv().await.unwrap();
    assert!(received.data.contains("Subject: =?utf-8?b?"));
}

#[tokio::test]
async fn a_bad_address_or_an_unreachable_server_is_an_error_not_a_panic() {
    assert!(SmtpMailer::new("not a url", "a@example.com").is_err());
    assert!(SmtpMailer::new("http://example.com", "a@example.com").is_err());
    assert!(SmtpMailer::new("smtp://127.0.0.1:1", "not an address").is_err());
    // 错误信息里不带地址本身：里面可能有密码
    let failed = SmtpMailer::new("ftp://user:secret@example.com", "a@example.com");
    assert!(!format!("{:?}", failed.err().unwrap()).contains("secret"));

    // 没有人在听的端口
    let mailer = SmtpMailer::new("smtp://127.0.0.1:1", "a@example.com").unwrap();
    let sent = mailer.send(&mail("boss@example.com", "hi", "hi")).await;
    assert!(sent.is_err());
    let (url, _inbox) = fake_smtp().await;
    let mailer = SmtpMailer::new(&url, "a@example.com").unwrap();
    assert!(
        mailer
            .send(&mail("not an address", "hi", "hi"))
            .await
            .is_err()
    );
}
