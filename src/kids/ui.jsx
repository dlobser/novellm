import React, { useEffect, useRef, useState } from 'react';
import { normalizeUpload } from './storage.js';

export function useImgUrl(store, id) {
  const [url, setUrl] = useState(() => (store && id ? store.syncUrl(id) : null));
  useEffect(() => {
    let alive = true;
    if (!store || !id) { setUrl(null); return undefined; }
    const s = store.syncUrl(id);
    if (s) { setUrl(s); return undefined; }
    store.url(id).then(u => { if (alive) setUrl(u); }).catch(() => {});
    return () => { alive = false; };
  }, [store, id]);
  return url;
}

export function Img({ store, id, className = '', style, onClick, title, alt = '' }) {
  const url = useImgUrl(store, id);
  if (!id) return <div className={`kb-img empty ${className}`} style={style} onClick={onClick} title={title}><span>no image</span></div>;
  return (
    <div className={`kb-img ${className}`} style={style} onClick={onClick} title={title}>
      {url ? <img src={url} alt={alt} /> : <span>loading…</span>}
    </div>
  );
}

// Opens a large view of an image.
export function Lightbox({ store, id, onClose }) {
  const url = useImgUrl(store, id);
  useEffect(() => {
    const k = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  if (!id) return null;
  return (
    <div className="kb-lightbox" onClick={onClose}>
      {url && <img src={url} alt="" />}
    </div>
  );
}

export function UploadButton({ onFiles, multiple = true, label = 'Upload image', className = 'btn btn-sm', accept = 'image/*' }) {
  const ref = useRef(null);
  return (
    <>
      <button className={className} onClick={() => ref.current?.click()}>{label}</button>
      <input
        ref={ref}
        type="file"
        accept={accept}
        multiple={multiple}
        style={{ display: 'none' }}
        onChange={async e => {
          const files = [...(e.target.files || [])];
          e.target.value = '';
          if (files.length) onFiles(await Promise.all(files.map(f => normalizeUpload(f))));
        }}
      />
    </>
  );
}

export function DropZone({ onFiles, children }) {
  const [over, setOver] = useState(false);
  return (
    <div
      className={`kb-drop ${over ? 'over' : ''}`}
      onDragOver={e => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={async e => {
        e.preventDefault();
        setOver(false);
        const files = [...e.dataTransfer.files].filter(f => f.type.startsWith('image/'));
        if (files.length) onFiles(await Promise.all(files.map(f => normalizeUpload(f))));
      }}
    >
      {children}
    </div>
  );
}

export function Spinner({ text }) {
  return <span className="kb-spin"><span className="spinner" />{text}</span>;
}

export function Field({ label, children, hint, style }) {
  return (
    <div className="kb-field" style={style}>
      {label && <label>{label}</label>}
      {children}
      {hint && <div className="kb-hint">{hint}</div>}
    </div>
  );
}

export function Check({ checked, onChange, children }) {
  return (
    <label className="kb-check">
      <input type="checkbox" checked={!!checked} onChange={e => onChange(e.target.checked)} />
      {children}
    </label>
  );
}

// Text input that only commits on blur/enter — keeps typing snappy on big books.
export function LazyText({ value, onCommit, multiline = false, ...rest }) {
  const [v, setV] = useState(value ?? '');
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setV(value ?? ''); }, [value]);
  const commit = () => { focused.current = false; if (v !== (value ?? '')) onCommit(v); };
  const props = {
    value: v,
    onChange: e => setV(e.target.value),
    onFocus: () => { focused.current = true; },
    onBlur: commit,
    ...rest,
  };
  return multiline ? <textarea {...props} /> : <input type="text" {...props} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} />;
}

export function Thumbs({ store, ids, activeId, onPick, onRemove, onOpen, size = 72 }) {
  if (!ids || !ids.length) return null;
  return (
    <div className="kb-thumbs">
      {ids.map(id => (
        <div key={id} className={`kb-thumb ${activeId === id ? 'active' : ''}`} style={{ width: size, height: size }}>
          <Img store={store} id={id} onClick={() => (onPick ? onPick(id) : onOpen?.(id))} title={onPick ? 'Use this one' : 'View'} />
          {onOpen && <button className="kb-thumb-zoom" title="View large" onClick={() => onOpen(id)}>⤢</button>}
          {onRemove && <button className="kb-thumb-x" title="Remove" onClick={() => onRemove(id)}>×</button>}
        </div>
      ))}
    </div>
  );
}
