use axum::routing::{get, post};
use local_network_file_transfer::{
    download, fs::FileStore, get_files_list, post_receive_file_from_client,
};
use tower_http::{
    decompression::RequestDecompressionLayer,
    limit::RequestBodyLimitLayer,
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};

const UPLOAD_LIMIT: usize = 1024 * 1024 * 1024;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let state = FileStore::new(None)?;

    let routes = axum::Router::new()
        .route("/upload", post(post_receive_file_from_client))
        .route("/files", get(get_files_list))
        .route("/files/{name}", get(download));

    let serve_dir = ServeDir::new("frontend/dist")
        .not_found_service(ServeFile::new("frontend/dist/index.html"));

    let app = axum::Router::new()
        .nest("/api", routes)
        .fallback_service(serve_dir)
        .layer(RequestDecompressionLayer::new())
        .layer(TraceLayer::new_for_http())
        .layer(RequestBodyLimitLayer::new(
            if let Ok(s) = std::env::var("UPLOAD_LIMIT") {
                s.parse().unwrap_or(UPLOAD_LIMIT)
            } else {
                UPLOAD_LIMIT
            },
        ))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await?;
    tracing::info!("Listening on {}", listener.local_addr()?);

    axum::serve(listener, app).await?;
    Ok(())
}