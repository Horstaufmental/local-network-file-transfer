pub mod fs;

use axum::{
    Json,
    body::Body,
    extract::{Multipart, Path, State},
    http::{HeaderMap, StatusCode, header},
    response::IntoResponse,
};
use serde::Serialize;
use tokio_util::io::ReaderStream;

use crate::fs::{FileInformation, FileStore};

macro_rules! misc_error {
    ($e:expr) => {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Something went wrong: {}", $e),
        )
            .into_response()
    };
}

#[axum::debug_handler]
pub async fn post_receive_file_from_client(
    State(store): State<FileStore>,
    mut multipart: Multipart,
) -> impl IntoResponse {
    let mut field = match multipart.next_field().await {
        Ok(f) => {
            if f.is_none() {
                tracing::error!("Field not found in request for upload");
                return (
                    StatusCode::BAD_REQUEST,
                    "Field not found in request".to_owned(),
                )
                    .into_response();
            } else {
                f.unwrap()
            }
        }
        Err(e) => {
            tracing::error!("Failed to retrieve field from request for upload: {e}");
            misc_error!(e);
        }
    };

    let name = match field.file_name() {
        Some(s) => s.to_owned(),
        None => {
            tracing::error!("File's name not found in field for upload");
            return (
                StatusCode::BAD_REQUEST,
                "File's name not found in field".to_owned(),
            )
                .into_response();
        }
    };

    let mut upload = match store.create_upload(&name).await {
        Ok(u) => u,
        Err(e) => {
            tracing::error!("Failed to create file for upload: {e}");
            if e.kind() == std::io::ErrorKind::InvalidFilename {
                return (
                    StatusCode::BAD_REQUEST,
                    format!("Invalid filename: {}", name),
                )
                    .into_response();
            }
            misc_error!(e);
        }
    };

    loop {
        let c = match field.chunk().await {
            Ok(c) => c,
            Err(e) => {
                tracing::error!("Failed to retrieve chunk from field: {e}");
                misc_error!(e);
            }
        };
        if let Some(chunk) = c {
            if let Err(e) = upload.write(&chunk).await {
                tracing::error!("Failed to write file from upload: {e}");
                misc_error!(e);
            }
        } else {
            break;
        }
    }

    match upload.finish().await {
        Ok(final_name) => (StatusCode::OK, final_name).into_response(),
        Err(e) => {
            tracing::error!("Failed to finish uploading: {e}");
            misc_error!(e);
        }
    }
}

#[derive(Serialize)]
pub struct FileList {
    list: Vec<FileInformation>,
}

#[axum::debug_handler]
pub async fn get_files_list(State(store): State<FileStore>) -> impl IntoResponse {
    // Pass `false` to exclude hidden/dotfiles from listing (previously
    // `true` due to inverted semantics – fixed to use correct meaning).
    let files = match store.list_files(false).await {
        Ok(list) => list,
        Err(e) => {
            tracing::error!("Failed to list files: {e}");
            misc_error!(e);
        }
    };

    (StatusCode::OK, Json(FileList { list: files })).into_response()
}

#[axum::debug_handler]
pub async fn download(
    State(store): State<FileStore>,
    Path(name): Path<String>,
) -> impl IntoResponse {
    let file = match store.open(&name).await {
        Ok(f) => f,
        Err(e) => {
            if e.kind() == std::io::ErrorKind::NotFound {
                return (StatusCode::NOT_FOUND, "Requested file not found").into_response();
            } else {
                tracing::error!("Failed to open file for download request: {e}");
                misc_error!(e);
            }
        }
    };

    let stream = ReaderStream::new(file);
    let body = Body::from_stream(stream);

    // Sanitize the name for the Content-Disposition header to prevent header
    // injection (quotes, newlines, control chars). Use the sanitized form that
    // corresponds to the stored file.
    let sanitized = sanitize_filename::sanitize_with_options(
        &name,
        sanitize_filename::Options {
            replacement: "_",
            windows: true,
            truncate: true,
        },
    );
    let safe_name = sanitized
        .replace('"', "_")
        .replace('\r', "_")
        .replace('\n', "_")
        .replace('\\', "_");
    // Fallback if sanitization produces empty string or header value is invalid.
    let disposition_value = format!("attachment; filename=\"{}\"", safe_name);
    let disposition_header: header::HeaderValue = disposition_value.parse().unwrap_or_else(|_| {
        // `attachment` without filename is always valid
        header::HeaderValue::from_static("attachment")
    });

    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("application/octet-stream"),
    );
    headers.insert(header::CONTENT_DISPOSITION, disposition_header);

    (StatusCode::OK, headers, body).into_response()
}