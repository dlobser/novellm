import React from 'react';

export default function Loading({ text = 'Generating...' }) {
  return (
    <div className="loading-indicator">
      <div className="spinner" />
      <span>{text}</span>
    </div>
  );
}
