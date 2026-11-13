import React, { useEffect, useState } from 'react';
import type { FileRef } from '../../server/src/contracts';
export function fileUrl(file: FileRef, token?: string) {
  return `/files?id=${encodeURIComponent(file.id)}&token=${encodeURIComponent(token || '')}`;
}
export function FileCard({ file, token, result = false }: { file: FileRef; token?: string; result?: boolean }) {
  const [missing, setMissing] = useState(false);
  const [content, setContent] = useState<{ blob: Blob; url: string }>();
  const [notice, setNotice] = useState('');
  useEffect(() => {
    setMissing(false); setContent(undefined);
    const controller = new AbortController();
    let objectUrl: string | undefined;
    if (token) void fetch(fileUrl(file, token), { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('unavailable');
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      setContent({ blob, url: objectUrl });
    }).catch(() => { if (!controller.signal.aborted) setMissing(true); });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [file.id, token]);
  const image = file.mime.startsWith('image/');
  async function copy() {
    if (!content) return;
    try {
      const png = (async () => {
        const bitmap = await createImageBitmap(content.blob);
        try {
          const canvas = document.createElement('canvas');
          canvas.width = bitmap.width; canvas.height = bitmap.height;
          canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
          return await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(), 'image/png'));
        } finally { bitmap.close(); }
      })();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
      setNotice('Imagen copiada.');
    } catch { setNotice('No pude copiar. Probá guardar la imagen.'); }
  }
  const action = 'inline-block rounded-lg border border-[#c6d0c9] px-3 py-2 text-sm hover:bg-[#e4ebe5] disabled:opacity-50 focus-visible:outline-3 focus-visible:outline-[#94733c] focus-visible:outline-offset-3';
  return <figure className="my-3 min-w-0 rounded-xl border border-[#d9ddd2] bg-[#fffefa] p-3">
    {image && !missing && content && <img className="max-h-64 w-full rounded-lg object-contain" src={content.url} alt={file.name} onError={() => setMissing(true)} />}
    <figcaption className="my-2 break-words text-sm">{file.name}</figcaption>
    {missing ? <p role="status" className="text-sm">Este archivo ya no está disponible.</p> : <div className="flex flex-wrap gap-2">
      {result && image && <button type="button" disabled={!content} className={action} onClick={() => void copy()}>Copiar</button>}
      {!image && content && <a className={action} href={content.url} target="_blank" rel="noreferrer">Abrir</a>}
      <button type="button" disabled={!content} className={action} onClick={() => {
        if (!content) return;
        const a = document.createElement('a'); a.href = content.url; a.download = file.name; a.click();
        setNotice('Archivo guardado.');
      }}>Guardar</button>
    </div>}
    <p role="status" className="mt-1 text-xs">{notice || (!missing && !content ? 'Cargando archivo…' : '')}</p>
  </figure>;
}
