import React from 'react';

/* Uppercase 10.5px faint headers, hairline row rules, mono IDs,
   right-aligned tabular figures, honest empty state. */
export function DataTable({ columns, rows, empty = 'No records yet.', renderCell }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col.key} style={col.align === 'right' ? { textAlign: 'right' } : undefined}>
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length ? (
            rows.map((row, i) => (
              <tr key={row.id ?? i}>
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={col.mono ? 'mono' : undefined}
                    style={col.align === 'right' ? { textAlign: 'right' } : undefined}
                  >
                    {renderCell ? renderCell(col, row) : row[col.key]}
                  </td>
                ))}
              </tr>
            ))
          ) : (
            <tr>
              <td className="empty-cell" colSpan={columns.length}>{empty}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
