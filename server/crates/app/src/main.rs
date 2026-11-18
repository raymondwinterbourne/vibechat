use std::process::ExitCode;

use vibechat_server::config::Config;

#[tokio::main]
async fn main() -> ExitCode {
    // 配置有问题时日志系统还没有初始化，直接写到标准错误
    let config = match Config::from_env() {
        Ok(config) => config,
        Err(err) => {
            eprintln!("configuration error: {err}");
            return ExitCode::FAILURE;
        }
    };

    tracing_subscriber::fmt()
        .with_max_level(config.log_level)
        .init();

    if let Err(err) = vibechat_server::run(config).await {
        tracing::error!("server stopped: {err}");
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}
