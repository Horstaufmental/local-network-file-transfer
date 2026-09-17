use std::{
    ffi::OsString,
    path::PathBuf,
    time::{Duration, UNIX_EPOCH},
};

use anyhow::{anyhow, bail};
use serde::Serialize;
#[cfg(any(unix, windows))]
use tokio::fs::DirEntry;
use tokio::{
    fs::{self, File, OpenOptions},
    io::{self, AsyncWriteExt},
};

const SANITIZE_OPTS: sanitize_filename::Options = sanitize_filename::Options {
    replacement: "_",
    windows: true,
    truncate: true,
};

#[derive(Clone)]
pub struct FileStore {
    root: PathBuf,
}

#[derive(Serialize)]
pub struct FileInformation {
    name: OsString,
    size: u64,
    timestamp: u64,
}

pub struct UploadHandle {
    file: Option<File>,
    /// Path to file
    path: PathBuf,
    /// Sanitized name
    name: String,
    completed: bool,
}

impl FileStore {
    pub fn new(p: Option<PathBuf>) -> Result<Self, anyhow::Error> {
        if let Some(path) = p {
            // Ensure the provided directory exists (create if needed)
            if let Err(e) = std::fs::create_dir_all(&path) {
                if e.kind() != std::io::ErrorKind::AlreadyExists {
                    tracing::error!("Failed to create storage directory: {e}");
                    bail!(e);
                }
            }
            return Ok(FileStore { root: path });
        }

        let dir = home::home_dir()
            .ok_or(anyhow!("$HOME"))?
            .join("DownloadStorage");
        if let Err(e) = std::fs::create_dir_all(&dir) {
            if e.kind() != std::io::ErrorKind::AlreadyExists {
                tracing::error!("Failed to create download storage directory: {e}");
                bail!(e);
            }
        }
        Ok(FileStore { root: dir })
    }

    pub async fn create_upload(&self, name: &str) -> io::Result<UploadHandle> {
        let san = sanitize_filename::sanitize_with_options(name, SANITIZE_OPTS);
        if san != name {
            tracing::warn!("Name has been sanitized for upload: {} --> {}", name, san);
        }
        // Reject empty or whitespace-only names after sanitization.
        if san.is_empty() || san.trim().is_empty() {
            return Err(std::io::ErrorKind::InvalidFilename.into());
        }
        if self.file_would_filter(&OsString::from(&san), false).await {
            return Err(std::io::ErrorKind::InvalidFilename.into());
        }

        // Use a dot-prefixed temp name so it is hidden from listing via dotfile
        // filter and cannot be downloaded via `open` (which rejects dotfiles).
        let p = self.root.join(format!(".{}.partial", san));

        let mut opts = OpenOptions::new();
        opts.create_new(true).write(true);

        let f = opts.open(&p).await?;

        Ok(UploadHandle {
            file: Some(f),
            path: p,
            name: san,
            completed: false,
        })
    }

    pub async fn open(&self, p: &str) -> io::Result<File> {
        let sanitized = sanitize_filename::sanitize_with_options(p, SANITIZE_OPTS);
        if sanitized.is_empty() {
            return Err(std::io::ErrorKind::NotFound.into());
        }
        if self
            .file_would_filter(&OsString::from(&sanitized), true)
            .await
        {
            return Err(std::io::ErrorKind::NotFound.into());
        }

        // Directly open the expected path instead of scanning directory (fixes
        // bug where `p` was opened relative to CWD rather than storage root).
        let candidate = self.root.join(&sanitized);
        // Verify the candidate is a file and matches exactly (no case-insensitive
        // tricks beyond what the filesystem does) and is not a directory.
        match fs::metadata(&candidate).await {
            Ok(meta) if meta.is_file() => Ok(File::open(&candidate).await?),
            _ => Err(std::io::ErrorKind::NotFound.into()),
        }
    }

    pub async fn list_files(&self, include_hidden: bool) -> io::Result<Vec<FileInformation>> {
        let mut entries = fs::read_dir(self.root.as_path()).await?;
        let mut list: Vec<FileInformation> = Vec::new();

        while let Some(entry) = entries.next_entry().await? {
            // FIX: `include_hidden` semantics were inverted. When true we should
            // return hidden files as well; when false we filter them out.
            let f = if include_hidden {
                Some(entry.file_name())
            } else {
                self.file_filter_hidden(&entry).await
            };
            if f.is_none() {
                continue;
            }

            let metadt = entry.metadata().await?;

            let s = metadt.len();

            // felt nice today, will just have the client
            // to not display time if is zero
            let ts = metadt
                .modified()
                .unwrap_or(UNIX_EPOCH)
                .duration_since(UNIX_EPOCH)
                .unwrap_or(Duration::from_secs(0))
                .as_secs();

            list.push(FileInformation {
                name: f.unwrap(),
                size: s,
                timestamp: ts,
            });
        }

        Ok(list)
    }

    async fn file_filter_hidden(&self, entry: &DirEntry) -> Option<OsString> {
        let n = entry.file_name();

        if self.file_would_filter(&n, true).await {
            None
        } else {
            Some(n)
        }
    }

    async fn file_would_filter(&self, n: &OsString, check_attr: bool) -> bool {
        // Hidden if the name starts with '.' (dotfile) on all platforms.
        // Use lossy conversion to handle non-unicode OsStrings safely.
        let hidden_by_name = n.to_string_lossy().starts_with('.');

        #[cfg(windows)]
        {
            if check_attr {
                use std::os::windows::fs::MetadataExt;
                let full_path = self.root.join(n);
                if let Ok(meta) = fs::metadata(&full_path).await {
                    let hidden_attr = (meta.file_attributes() & 0x2) != 0;
                    return hidden_by_name || hidden_attr;
                }
            }
        }
        let _ = check_attr; // suppress unused warning on non-windows
        hidden_by_name
    }
}

impl UploadHandle {
    pub async fn write(&mut self, data: &[u8]) -> io::Result<()> {
        if let Some(f) = &mut self.file {
            f.write_all(data).await?;
        }
        Ok(())
    }

    pub async fn finish(mut self) -> io::Result<String> {
        if let Some(mut f) = self.file.take() {
            f.flush().await?;
            drop(f);
        }

        let parent = self
            .path
            .parent()
            .unwrap_or_else(|| std::path::Path::new("."));
        // first try: regular creation
        let mut target_path = parent.join(&self.name);
        if !target_path.exists() {
            fs::rename(&self.path, &target_path).await?;
            self.completed = true;
            return Ok(self.name.clone());
        }

        // duplicates found: try suffixing with (n) - handle edge cases correctly
        let fp = std::path::Path::new(&self.name);
        // file_stem can be None for names like ".gitignore" or when name is empty
        let stem = fp
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| fp.file_name().unwrap_or_default().to_string_lossy().to_string());
        let ext = fp.extension().map(|e| e.to_string_lossy().to_string());

        for i in 1..100 {
            let file_name = match &ext {
                Some(e) => format!("{} ({}).{}", stem, i, e),
                None => format!("{} ({})", stem, i),
            };
            target_path = parent.join(&file_name);
            if !target_path.exists() {
                fs::rename(&self.path, &target_path).await?;
                self.completed = true;
                return Ok(target_path
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .to_owned()
                    .to_string());
            }
        }

        Err(std::io::ErrorKind::AlreadyExists.into())
    }

    pub async fn abort(mut self) -> io::Result<()> {
        self.file.take();
        fs::remove_file(&self.path).await?;
        self.completed = true;
        Ok(())
    }
}

impl Drop for UploadHandle {
    fn drop(&mut self) {
        if !self.completed {
            self.file.take();
            let _ = std::fs::remove_file(&self.path);
        }
    }
}