import { useEffect, useState } from 'react'
import type { MediaView } from './view.ts'
import { client, fileName } from './triage.ts'

/** Screenshots as thumbnails that open full size, and recordings inline. */
export function MediaStrip({ media, onOpenFile }: { media: MediaView[]; onOpenFile: (path: string) => void }) {
  const [open, setOpen] = useState<number | null>(null)
  const images = media.filter((entry) => entry.kind === 'image')
  const videos = media.filter((entry) => entry.kind === 'video')
  const files = media.filter((entry) => entry.kind === 'file')
  return (
    <div className="media">
      {images.length > 0 && (
        <ul className="thumbs" aria-label="Screenshots">
          {images.map((image, index) => (
            <li key={image.id}>
              <button type="button" className="thumb" onClick={() => setOpen(index)} title={image.label}>
                <img src={client.fileUrl(image.id)} alt={image.label} loading="lazy" />
                <span>{image.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {videos.map((video) => (
        <figure key={video.id} className="video">
          <video src={client.fileUrl(video.id)} controls preload="metadata" />
          <figcaption>
            {video.label} ·{' '}
            <button type="button" className="link" onClick={() => onOpenFile(video.path)}>
              Open
            </button>
          </figcaption>
        </figure>
      ))}
      {files.length > 0 && (
        <ul className="files">
          {files.map((file) => (
            <li key={file.id}>
              <button type="button" className="link" onClick={() => onOpenFile(file.path)} title={file.path}>
                {file.label || fileName(file.path)}
              </button>
            </li>
          ))}
        </ul>
      )}
      {open !== null && images[open] && <Lightbox images={images} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />}
    </div>
  )
}

function Lightbox({ images, index, onIndex, onClose }: { images: MediaView[]; index: number; onIndex: (index: number) => void; onClose: () => void }) {
  const image = images[index]!
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      else if (event.key === 'ArrowRight') onIndex((index + 1) % images.length)
      else if (event.key === 'ArrowLeft') onIndex((index - 1 + images.length) % images.length)
      else return
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [images.length, index, onClose, onIndex])
  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={image.label} onClick={onClose}>
      <figure onClick={(event) => event.stopPropagation()}>
        <img src={client.fileUrl(image.id)} alt={image.label} />
        <figcaption>
          <span>{image.label}</span>
          <span className="muted">
            {index + 1} of {images.length} · ← → · Esc
          </span>
        </figcaption>
      </figure>
    </div>
  )
}
