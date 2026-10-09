// Progressive enhancement for the partners pages: a new partner's code follows its name until the
// operator edits the code, and the price preview follows the offer as it is typed. The form works
// without either. IIFE so nothing leaks into the concatenated bundle.

export const partnersEnhancerJs = `(() => {
  // --- code from name: "Casa do Largo" becomes "casa-do-largo", the link preview with it ---
  const nameInput = document.querySelector('[data-reserva-partner-name]');
  const codeInput = document.querySelector('[data-reserva-partner-code]');
  const linkPreview = document.querySelector('[data-reserva-partner-link]');
  if (nameInput && codeInput) {
    const slug = (text) => text.normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/, '');
    const showLink = () => {
      if (linkPreview) linkPreview.textContent = linkPreview.dataset.reservaPartnerLink + (codeInput.value || 'code');
    };
    // A code typed by hand (or kept from a refused save) is the operator's choice; leave it alone.
    let follows = codeInput.value === '' || codeInput.value === slug(nameInput.value);
    nameInput.addEventListener('input', () => {
      if (!follows) return;
      codeInput.value = slug(nameInput.value);
      showLink();
    });
    codeInput.addEventListener('input', () => {
      follows = codeInput.value === '';
      showLink();
    });
  }

  // --- price preview: same integer arithmetic as the server, half-up on the discount ---
  const preview = document.querySelector('[data-reserva-offer-preview]');
  const form = preview && preview.closest('form');
  if (!preview || !form) return;
  const percentInput = form.querySelector('[data-reserva-offer-percentage]');
  const offerSwitch = form.querySelector('[data-reserva-offer-switch]');
  const money = new Intl.NumberFormat(preview.dataset.locale === 'en' ? 'en-GB' : preview.dataset.locale, { style: 'currency', currency: preview.dataset.currency.toUpperCase() });
  const digits = money.resolvedOptions().maximumFractionDigits;
  const format = (minor) => money.format(minor / Math.pow(10, digits));
  const minimum = preview.dataset.minimum === '' ? null : Number(preview.dataset.minimum);
  const basisPoints = () => {
    const match = /^(\\d{1,3})(?:[.,](\\d{1,2}))?$/.exec(percentInput.value.trim() || '0');
    if (!match) return null;
    const value = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
    return value <= 10000 ? value : null;
  };
  const render = () => {
    const points = offerSwitch.checked ? basisPoints() : 0;
    const waived = new Set([...form.querySelectorAll('input[name="waived_pickup"]:checked')].map((box) => box.value));
    for (const cell of preview.querySelectorAll('td[data-original]')) {
      const original = Number(cell.dataset.original);
      const discount = points === null ? 0 : Math.floor((Number(cell.dataset.service) * points + 5000) / 10000);
      const pickupOff = offerSwitch.checked && waived.has(cell.dataset.pickupId) ? Number(cell.dataset.pickup) : 0;
      const price = original - discount - pickupOff;
      cell.replaceChildren();
      if (price >= original) {
        cell.textContent = format(original);
        continue;
      }
      const was = document.createElement('s');
      was.textContent = format(original);
      const now = document.createElement('b');
      now.textContent = format(price);
      cell.append(was, ' ', now);
      if (minimum !== null && price < minimum) {
        const below = document.createElement('span');
        below.className = 'bk-partner-below';
        below.textContent = preview.dataset.below;
        cell.append(' ', below);
      }
    }
  };
  form.addEventListener('input', render);
  form.addEventListener('change', render);
})();
`;
