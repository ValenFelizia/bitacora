import React, { useEffect, useState } from 'react';
import type { FileRef } from '../../server/src/contracts';
export function fileUrl(file: FileRef, token?: string, download = false) {
  return `/files?id=${encodeURIComponent(file.id)}&token=${encodeURIComponent(token || '')}${download ? '&download=1' : ''}`;
}
export function FileCard({ file, token, result = false }: { file: FileRef; token?: string; result?: boolean }) {
  const [missing, setMissing] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    setMissing(false);
    let active = true;
    if (token) void fetch(fileUrl(file, token), { method: 'HEAD' }).then(r => { if (active) setMissing(!r.ok); }).catch(() => { if (active) setMissing(true); });
    return () => { active = false; };
  }, [file.id, token]);
  const url = fileUrl(file, token);
  const image = file.mime.startsWith('image/');
  async function copy() {
    try {
      // Start the clipboard write inside the click, before decoding the image.
      const png = (async () => {
        const response = await fetch(url);
        if (!response.ok) throw new Error('missing');
        const bitmap = await createImageBitmap(await response.blob());
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
  const action = 'inline-block rounded-lg border border-[#c6d0c9] px-3 py-2 text-sm hover:bg-[#e4ebe5] focus-visible:outline-3 focus-visible:outline-[#94733c] focus-visible:outline-offset-3';
  return <figure className="my-3 min-w-0 rounded-xl border border-[#d9ddd2] bg-[#fffefa] p-3">
    {image && !missing && token && <img className="max-h-64 w-full rounded-lg object-contain" src={url} alt={file.name} onError={() => setMissing(true)} />}
    <figcaption className="my-2 break-words text-sm">{file.name}</figcaption>
    {missing ? <p role="status" className="text-sm">Este archivo ya no está disponible.</p> : <div className="flex flex-wrap gap-2">
      {result && image && <button type="button" className={action} onClick={() => void copy()}>Copiar</button>}
      {!image && <a className={action} href={url} target="_blank" rel="noreferrer">Abrir</a>}
      <button type="button" className={action} onClick={async () => {
        try {
          const response = await fetch(fileUrl(file, token, true));
          if (!response.ok) { setMissing(true); return; }
          const blob = URL.createObjectURL(await response.blob());
          const a = document.createElement('a'); a.href = blob; a.download = file.name; a.click();
          setTimeout(() => URL.revokeObjectURL(blob), 10000);
          setNotice('Archivo guardado.');
        } catch { setNotice('No pude guardar. Probá de nuevo.'); }
      }}>Guardar</button>
    </div>}
    <p role="status" className="mt-1 text-xs">{notice}</p>
  </figure>;
}
