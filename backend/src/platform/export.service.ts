import { Injectable } from '@nestjs/common';
// pdfkit is a CommonJS module; the require form keeps the constructor intact
// without enabling esModuleInterop project-wide.
import PDFDocument = require('pdfkit');

export interface ExportColumn {
  /** Property name on each row object. */
  key: string;
  /** Human heading used in CSV header and PDF table. */
  header: string;
  /** Relative width weight for PDF layout (default 1). */
  weight?: number;
}

export interface ExportMetadata {
  title: string;
  tenantLabel?: string;
  requestedBy?: string;
  filtersApplied?: string;
  rowCount: number;
}

function cellText(row: Record<string, unknown>, key: string): string {
  const value = key.split('.').reduce<unknown>((acc, part) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[part];
    return undefined;
  }, row);
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Uniform CSV and PDF exports for grid endpoints. Every export is bounded by
 * the caller (grid limits apply) and audit-logged by the audit trail
 * interceptor, which matches /export.csv and /export.pdf paths.
 */
@Injectable()
export class ExportService {
  toCsv(rows: Array<Record<string, unknown>>, columns: ExportColumn[]): string {
    const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
    const lines = [columns.map((column) => escape(column.header)).join(',')];
    for (const row of rows) {
      lines.push(columns.map((column) => escape(cellText(row, column.key))).join(','));
    }
    return lines.join('\r\n');
  }

  toPdf(
    rows: Array<Record<string, unknown>>,
    columns: ExportColumn[],
    metadata: ExportMetadata,
  ): Promise<Buffer> {
    return new Promise((resolvePdf, rejectPdf) => {
      const document = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36 });
      const chunks: Buffer[] = [];
      document.on('data', (chunk: Buffer) => chunks.push(chunk));
      document.on('end', () => resolvePdf(Buffer.concat(chunks)));
      document.on('error', rejectPdf);

      const pageWidth =
        document.page.width - document.page.margins.left - document.page.margins.right;
      const totalWeight = columns.reduce((sum, column) => sum + (column.weight ?? 1), 0);
      const widths = columns.map((column) => ((column.weight ?? 1) / totalWeight) * pageWidth);
      const left = document.page.margins.left;

      document.fontSize(14).font('Helvetica-Bold').text(`JKANNEL — ${metadata.title}`);
      document
        .fontSize(8)
        .font('Helvetica')
        .fillColor('#555555')
        .text(
          [
            `Generated ${new Date().toISOString()}`,
            metadata.tenantLabel ? `Tenant ${metadata.tenantLabel}` : undefined,
            metadata.requestedBy ? `Requested by ${metadata.requestedBy}` : undefined,
            metadata.filtersApplied ? `Filters: ${metadata.filtersApplied}` : undefined,
            `${metadata.rowCount} rows`,
          ]
            .filter(Boolean)
            .join('  ·  '),
        )
        .fillColor('#000000');
      document.moveDown(0.5);

      const drawHeader = () => {
        const y = document.y;
        document.fontSize(8).font('Helvetica-Bold');
        columns.forEach((column, index) => {
          const x = left + widths.slice(0, index).reduce((sum, width) => sum + width, 0);
          document.text(column.header, x, y, { width: widths[index] - 6 });
        });
        document
          .moveTo(left, document.y + 2)
          .lineTo(left + pageWidth, document.y + 2)
          .strokeColor('#999999')
          .stroke();
        document.moveDown(0.3);
        document.font('Helvetica');
      };

      drawHeader();
      for (const row of rows) {
        const startY = document.y;
        let tallest = 0;
        columns.forEach((column, index) => {
          const x = left + widths.slice(0, index).reduce((sum, width) => sum + width, 0);
          const value = cellText(row, column.key);
          const height = document.heightOfString(value, { width: widths[index] - 6 });
          document.fontSize(7.5).text(value, x, startY, { width: widths[index] - 6 });
          tallest = Math.max(tallest, height);
        });
        document.y = startY + tallest + 4;
        if (document.y > document.page.height - document.page.margins.bottom - 40) {
          document.addPage();
          drawHeader();
        }
      }
      document.end();
    });
  }
}
