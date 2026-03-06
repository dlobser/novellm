import React from 'react';

// Generic dynamic array of items with add/remove
// renderItem(item, index, updateItem) should return the form fields
export default function DynamicArray({ items, setItems, renderItem, newItem, addLabel = '+ Add' }) {
  const add = () => setItems([...items, typeof newItem === 'function' ? newItem() : { ...newItem }]);
  const remove = (idx) => setItems(items.filter((_, i) => i !== idx));
  const update = (idx, updated) => {
    const next = [...items];
    next[idx] = updated;
    setItems(next);
  };

  return (
    <div>
      {items.map((item, i) => (
        <div key={i} className="array-item">
          <div className="fields">
            {renderItem(item, i, (updated) => update(i, updated))}
          </div>
          <button className="remove-btn" onClick={() => remove(i)} title="Remove">×</button>
        </div>
      ))}
      <button className="btn btn-sm mt-sm" onClick={add}>{addLabel}</button>
    </div>
  );
}
