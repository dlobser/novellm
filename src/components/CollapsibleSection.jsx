import React, { useState } from 'react';

export default function CollapsibleSection({ title, children, defaultOpen = false, actions }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="section">
      <div className="section-header" onClick={() => setOpen(!open)}>
        <h3>{title}</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {actions && <div onClick={e => e.stopPropagation()}>{actions}</div>}
          <span className={`toggle ${open ? 'open' : ''}`}>▼</span>
        </div>
      </div>
      {open && <div className="section-body">{children}</div>}
    </div>
  );
}
