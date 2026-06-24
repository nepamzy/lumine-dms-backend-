// Converts an array of plain objects into a CSV string. No external
// dependency needed for this — the data shapes here are simple and flat.
function toCSV(rows) {
  if (!rows || rows.length === 0) return "";

  const headers = Object.keys(rows[0]);
  const escape = (value) => {
    if (value === null || value === undefined) return "";
    const str = String(value);
    // Wrap in quotes if it contains a comma, quote, or newline
    if (/[",\n]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const headerLine = headers.join(",");
  const dataLines = rows.map((row) => headers.map((h) => escape(row[h])).join(","));
  return [headerLine, ...dataLines].join("\n");
}

module.exports = { toCSV };
