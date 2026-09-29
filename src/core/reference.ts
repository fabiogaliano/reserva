export function generateReference(shortCode: string, year: number, sequence: number): string {
  if (!/^[A-Za-z][A-Za-z0-9]{0,9}$/.test(shortCode)) throw new RangeError('Invalid business shortCode');
  if (!Number.isInteger(year) || year < 1) throw new RangeError('Invalid reference year');
  if (!Number.isInteger(sequence) || sequence < 1) throw new RangeError('Invalid reference sequence');
  return `${shortCode.toUpperCase()}-${year}-${String(sequence).padStart(3, '0')}`;
}
