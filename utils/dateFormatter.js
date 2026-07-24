const parseDateInput = (dateInput) => {
  if (dateInput === undefined || dateInput === null) return null;

  if (dateInput instanceof Date) {
    return Number.isNaN(dateInput.getTime()) ? null : dateInput;
  }

  if (typeof dateInput === 'number') {
    const d = new Date(dateInput);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  if (typeof dateInput === 'string') {
    const v = dateInput.trim();
    if (!v) return null;

    // ISO date yyyy-mm-dd
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      const [y, m, d] = v.split('-').map(Number);
      const dt = new Date(y, m - 1, d);
      return Number.isNaN(dt.getTime()) ? null : dt;
    }

    // ISO datetime
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(v)) {
      const normalized = v.replace(' ', 'T');
      const [datePart, timePart] = normalized.split('T');
      const [y, m, d] = datePart.split('-').map(Number);
      const [hh = 0, mm = 0, ss = 0] = (timePart || '').split(':').map(Number);
      const dt = new Date(y, m - 1, d, hh, mm, ss);
      return Number.isNaN(dt.getTime()) ? null : dt;
    }

    const dt = new Date(v);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }

  return null;
};

const formatDate = (dateInput) => {
  const d = parseDateInput(dateInput);
  if (!d) return '';
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
};

module.exports = {
  parseDateInput,
  formatDate,
};
