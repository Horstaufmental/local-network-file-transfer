import { useCallback, useEffect, useRef, useState } from 'react'

type FileInfo = { name: string; size: number; timestamp: number }

type Banner = { kind: 'success' | 'error'; msg: string } | null
type QueueItem = { file: File; progress: number; status: 'queued' | 'uploading' | 'done' | 'error' }

const BLOB_THRESHOLD = 100 * 1024 * 1024 // 100 MB — above this use direct anchor streaming

function humanBytes(b: number): string {
  if (b === 0) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(b) / Math.log(1024)), u.length - 1)
  const v = b / 1024 ** i
  return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10} ${u[i]}`
}

function formatTs(ts: number): string {
  if (!ts) return '—'
  try {
    return new Date(ts * 1000).toLocaleString()
  } catch {
    return '—'
  }
}

function extOf(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return ''
  return name.slice(dot + 1).toLowerCase()
}

function fileKind(name: string): { label: string; bg: string } {
  const e = extOf(name)
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].includes(e)) return { label: e.toUpperCase(), bg: '#16a34a' }
  if (['mp4', 'mov', 'mkv', 'avi', 'webm'].includes(e)) return { label: e.toUpperCase(), bg: '#7c3aed' }
  if (['mp3', 'wav', 'flac', 'ogg', 'm4a'].includes(e)) return { label: e.toUpperCase(), bg: '#db2777' }
  if (['zip', 'tar', 'gz', 'rar', '7z'].includes(e)) return { label: e.toUpperCase(), bg: '#ea580c' }
  if (['pdf'].includes(e)) return { label: 'PDF', bg: '#dc2626' }
  if (['txt', 'md'].includes(e)) return { label: e.toUpperCase(), bg: '#6b7280' }
  if (['js', 'ts', 'py', 'rs', 'go', 'json', 'html', 'css'].includes(e)) return { label: e.toUpperCase(), bg: '#2563eb' }
  return { label: e ? e.slice(0, 3).toUpperCase() : 'FILE', bg: '#6b6375' }
}

function uploadViaXhr(file: File, onProgress: (pct: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/upload')
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.responseText)
      else reject(new Error(xhr.responseText || `Upload failed (${xhr.status})`))
    }
    xhr.onerror = () => reject(new Error('Network error during upload'))
    xhr.onabort = () => reject(new Error('Upload aborted'))
    const fd = new FormData()
    fd.append('file', file, file.name)
    xhr.send(fd)
  })
}

export default function App() {
  const [files, setFiles] = useState<FileInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const [banner, setBanner] = useState<Banner>(null)
  const [dragging, setDragging] = useState(false)
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const queueRef = useRef<File[]>([])

  const fetchList = useCallback(async () => {
    setLoading(true)
    setListError(null)
    try {
      const r = await fetch('/api/files')
      if (!r.ok) throw new Error(await r.text().catch(() => `Failed (${r.status})`))
      const j = (await r.json()) as { list: FileInfo[] }
      const sorted = [...j.list].sort((a, b) => b.timestamp - a.timestamp)
      setFiles(sorted)
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchList()
  }, [fetchList])

  // auto-dismiss banner
  useEffect(() => {
    if (!banner) return
    const t = setTimeout(() => setBanner(null), 4500)
    return () => clearTimeout(t)
  }, [banner])

  const processQueue = useCallback(async () => {
    if (busy) return
    const next = queueRef.current.shift()
    if (!next) return
    setBusy(true)
    setQueue((q) => q.map((it) => (it.file === next && it.status === 'queued' ? { ...it, status: 'uploading', progress: 0 } : it)))
    try {
      const finalName = await uploadViaXhr(next, (pct) => {
        setQueue((q) => q.map((it) => (it.file === next ? { ...it, progress: pct } : it)))
      })
      setQueue((q) => q.map((it) => (it.file === next ? { ...it, progress: 100, status: 'done' } : it)))
      if (finalName !== next.name) {
        setBanner({ kind: 'success', msg: `Uploaded "${next.name}" as "${finalName}"` })
      } else {
        setBanner({ kind: 'success', msg: `Uploaded "${finalName}"` })
      }
      await fetchList()
      // clear done after short delay to show completion
      setTimeout(() => setQueue((q) => q.filter((it) => it.file !== next)), 1200)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setQueue((q) => q.map((it) => (it.file === next ? { ...it, status: 'error' } : it)))
      setBanner({ kind: 'error', msg: `Failed to upload "${next.name}": ${msg}` })
      setTimeout(() => setQueue((q) => q.filter((it) => it.file !== next)), 3000)
    } finally {
      setBusy(false)
    }
  }, [busy, fetchList])

  const enqueue = useCallback(
    (list: FileList | File[]) => {
      const arr = Array.from(list)
      if (!arr.length) return
      queueRef.current.push(...arr)
      setQueue((q) => [...q, ...arr.map((f) => ({ file: f, progress: 0, status: 'queued' as const }))])
      setBanner(null)
      // kick off if idle
      if (!busy) setTimeout(() => void processQueue(), 0)
    },
    [busy, processQueue],
  )

  // when busy flips to false and queueRef has items, auto-continue (handles sequential)
  useEffect(() => {
    if (!busy && queueRef.current.length > 0) void processQueue()
  }, [busy, processQueue])

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragging(false)
      if (busy) return
      if (e.dataTransfer.files?.length) enqueue(e.dataTransfer.files)
    },
    [busy, enqueue],
  )

  const onPick = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files?.length) enqueue(e.target.files)
      // reset so same file can be picked again
      e.target.value = ''
    },
    [enqueue],
  )

  const handleDownload = useCallback(async (name: string, size: number) => {
    const enc = encodeURIComponent(name)
    const url = `/api/files/${enc}`
    // large → direct streaming via anchor (zero JS memory, respects ReaderStream)
    if (size > BLOB_THRESHOLD) {
      const a = document.createElement('a')
      a.href = url
      a.download = name
      document.body.appendChild(a)
      a.click()
      a.remove()
      return
    }
    try {
      const r = await fetch(url)
      if (!r.ok) {
        const t = await r.text().catch(() => '')
        throw new Error(t || `Download failed (${r.status})`)
      }
      const blob = await r.blob()
      const href = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = href
      a.download = name
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(href), 4000)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setBanner({ kind: 'error', msg: `Download failed for "${name}": ${msg}` })
    }
  }, [])

  return (
    <>
      <header className="app-header">
        <h1>Local Network File Transfer</h1>
        <p>
          Drop files to share on this network. Stored under <code>~/DownloadStorage</code> on the server. Up to 1 GiB per file.
        </p>
      </header>

      <section className="card" aria-labelledby="upload-heading">
        <div className="card-head">
          <h2 id="upload-heading">
            <span className="dot" aria-hidden />
            Upload
          </h2>
          <span className="count">{busy ? 'uploading…' : 'ready'}</span>
        </div>

        <div
          className={`dropzone ${dragging ? 'dragging' : ''} ${busy ? 'disabled' : ''}`}
          onDragOver={(e) => {
            e.preventDefault()
            if (!busy) setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => !busy && inputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              if (!busy) inputRef.current?.click()
            }
          }}
          role="button"
          tabIndex={0}
          aria-label="Upload files — click to browse or drag and drop"
          aria-busy={busy}
        >
          <div className="drop-icon" aria-hidden>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 16V4" />
              <path d="M8 8l4-4 4 4" />
              <path d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
            </svg>
          </div>
          <p className="drop-title">{dragging ? 'Drop to upload' : 'Drag & drop files here'}</p>
          <p className="drop-sub">
            or <strong>click to browse</strong> · sanitized & deduped on server
          </p>
          <input ref={inputRef} type="file" multiple className="sr-only" tabIndex={-1} onChange={onPick} disabled={busy} />
        </div>

        {banner && (
          <div className={`banner ${banner.kind === 'success' ? 'banner-success' : 'banner-error'}`} role="status">
            <span aria-hidden>{banner.kind === 'success' ? '✓' : '⚠'}</span>
            <span>{banner.msg}</span>
          </div>
        )}

        {queue.length > 0 && (
          <div className="upload-area" aria-live="polite">
            {queue.map((it) => (
              <div key={`${it.file.name}-${it.file.size}`} className="queue-item">
                <div className="file-icon" style={{ background: fileKind(it.file.name).bg, fontSize: 9 }}>
                  {fileKind(it.file.name).label.slice(0, 4)}
                </div>
                <div className="queue-meta">
                  <div className="queue-name" title={it.file.name}>
                    {it.file.name}
                  </div>
                  <div className="queue-sub">
                    {humanBytes(it.file.size)} · {it.status === 'error' ? 'error' : it.status === 'done' ? 'done' : it.status === 'uploading' ? 'uploading' : 'queued'}
                  </div>
                </div>
                <div className="progress-track" aria-hidden>
                  <div className="progress-fill" style={{ width: `${it.progress}%`, background: it.status === 'error' ? 'var(--danger)' : it.status === 'done' ? 'var(--success)' : undefined }} />
                </div>
                <span className="progress-pct">{it.progress}%</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="files-heading">
        <div className="card-head">
          <h2 id="files-heading">
            <span className="dot" aria-hidden style={{ background: 'var(--success)', boxShadow: '0 0 0 4px #dcfce7' }} />
            Files on server
          </h2>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span className="count">{loading ? '…' : `${files.length} file${files.length === 1 ? '' : 's'}`}</span>
            <button className="btn btn-ghost btn-small" onClick={() => void fetchList()} disabled={loading} aria-label="Refresh file list">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M21 12a9 9 0 11-2.64-6.36" />
                <path d="M21 3v6h-6" />
              </svg>
              Refresh
            </button>
          </div>
        </div>

        {listError ? (
          <div className="banner banner-error" style={{ margin: 16 }}>
            <span>⚠</span>
            <span>
              Failed to load files: {listError}{' '}
              <button className="btn btn-ghost btn-small" style={{ marginLeft: 8 }} onClick={() => void fetchList()}>
                Retry
              </button>
            </span>
          </div>
        ) : loading ? (
          <div className="table-wrap">
            <table className="files" aria-busy="true">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Size</th>
                  <th>Modified</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {[0, 1, 2].map((i) => (
                  <tr key={i} className="sk-row skeleton">
                    <td>
                      <div className="sk sk-name" />
                    </td>
                    <td>
                      <div className="sk sk-size" />
                    </td>
                    <td>
                      <div className="sk sk-date" />
                    </td>
                    <td>
                      <div className="sk" style={{ width: 72, height: 24, borderRadius: 7 }} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : files.length === 0 ? (
          <div className="empty">
            <div className="empty-icon" aria-hidden>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H7a2 2 0 00-2 2v16a2 2 0 002 2h10a2 2 0 002-2V8z" />
                <path d="M14 2v6h6" />
                <path d="M12 18v-6" />
                <path d="M9 15l3 3 3-3" />
              </svg>
            </div>
            <p className="empty-title">No files yet</p>
            <p className="empty-sub">Upload a file above — it will appear here and be available at GET /api/files/:name for any device on the network.</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="files">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Size</th>
                  <th>Modified</th>
                  <th>Download</th>
                </tr>
              </thead>
              <tbody>
                {files.map((f) => {
                  const k = fileKind(f.name)
                  return (
                    <tr key={f.name}>
                      <td>
                        <div className="file-cell">
                          <span className="file-icon" style={{ background: k.bg }}>
                            {k.label.slice(0, 4)}
                          </span>
                          <div style={{ minWidth: 0 }}>
                            <div className="file-name" title={f.name}>
                              {f.name}
                            </div>
                            <div className="file-sub mono">{extOf(f.name) ? `.${extOf(f.name)}` : 'file'}</div>
                          </div>
                        </div>
                      </td>
                      <td className="size-col mono">{humanBytes(f.size)}</td>
                      <td className="date-col">{formatTs(f.timestamp)}</td>
                      <td>
                        <button
                          className="btn btn-ghost btn-small"
                          onClick={() => void handleDownload(f.name, f.size)}
                          aria-label={`Download ${f.name}`}
                          title={f.size > BLOB_THRESHOLD ? 'Large file — streamed directly' : 'Download'}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                            <path d="M12 16V4" />
                            <path d="M8 10l4 4 4-4" />
                            <path d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
                          </svg>
                          Download
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <div className='footer'>
        <a target='_blank' href='https://github.com/Horstaufmental/local-network-file-transfer'>Github Repository</a> · Licensed in Apache 2.0
      </div>
    </>
  )
}
