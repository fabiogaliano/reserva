function escape(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);
}

export function renderManagePage(payload: Record<string, unknown>, managePagePath: string): string {
  const booking = payload.booking && typeof payload.booking === 'object' ? payload.booking as Record<string, unknown> : {};
  const role = payload.role === 'operator' ? 'operator' : 'customer';
  const canCancel = payload.canCancel === true;
  const canReschedule = payload.canReschedule === true;
  const canNoShow = payload.canNoShow === true;
  const token = typeof payload.token === 'string' ? payload.token : '';
  const reference = escape(booking.reference);
  const start = escape(booking.start);
  const tour = escape(booking.tourSlug);
  const people = escape(booking.people);
  const cancelTokenField = role === 'operator' ? 'operatorToken' : 'token';
  const refundControl = role === 'operator'
    ? '<label>Refund <select name="refund"><option value="none">No refund</option><option value="full">Full refund</option></select></label>'
    : '<input type="hidden" name="refund" value="none">';
  const cancelForm = canCancel ? `<form method="post" action="${escape(managePagePath)}"><input type="hidden" name="action" value="cancel"><input type="hidden" name="${cancelTokenField}" value="${escape(token)}">${refundControl}<button type="submit">Cancel booking</button></form>` : '';
  const rescheduleForm = canReschedule ? `<form method="post" action="${escape(managePagePath)}"><input type="hidden" name="action" value="reschedule"><input type="hidden" name="${cancelTokenField}" value="${escape(token)}"><label>New start <input name="newStart" type="datetime-local" required></label><button type="submit">Reschedule</button></form>` : '';
  const noShowForm = canNoShow ? `<form method="post" action="${escape(managePagePath)}"><input type="hidden" name="action" value="no-show"><input type="hidden" name="operatorToken" value="${escape(token)}"><button type="submit">Mark no-show</button></form>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Manage booking ${reference}</title></head><body><main><h1>Manage booking ${reference}</h1><dl><dt>Tour</dt><dd>${tour}</dd><dt>Start</dt><dd>${start}</dd><dt>People</dt><dd>${people}</dd><dt>Role</dt><dd>${role}</dd></dl><section aria-label="Booking actions">${cancelForm}${rescheduleForm}${noShowForm}</section></main></body></html>`;
}
