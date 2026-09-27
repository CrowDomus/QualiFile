const DIAGNOSTIC_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function normalizeType(value, fallback = 'Error') {
  const candidate = typeof value === 'string' ? value : '';
  if (DIAGNOSTIC_TYPE_PATTERN.test(candidate)) return candidate;
  return DIAGNOSTIC_TYPE_PATTERN.test(fallback) ? fallback : 'Error';
}

function normalizeStatus(value) {
  const status = Number(value);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

function normalizeRequestId(value) {
  const requestId = typeof value === 'string' ? value : '';
  return REQUEST_ID_PATTERN.test(requestId) ? requestId : null;
}

/**
 * Return the complete privacy-safe diagnostic shape.
 *
 * Message, stack, URL, payload, paths, and arbitrary object properties are
 * deliberately excluded from this boundary.
 */
export function safeDiagnostic(value, fallbackType = 'Error') {
  return {
    type: normalizeType(value?.name, fallbackType),
    status: normalizeStatus(value?.status),
    requestId: normalizeRequestId(value?.requestId ?? value?.request_id),
  };
}

function diagnosticFor(type, value) {
  return {
    ...safeDiagnostic(value, type),
    type: normalizeType(type),
  };
}

export function debugDiagnostic(type, value) {
  // eslint-disable-next-line no-console
  console.debug('[QualiFile][diagnostic]', diagnosticFor(type, value));
}

export function warnDiagnostic(type, value) {
  // eslint-disable-next-line no-console
  console.warn('[QualiFile][diagnostic]', diagnosticFor(type, value));
}

export function errorDiagnostic(type, value) {
  // eslint-disable-next-line no-console
  console.error('[QualiFile][diagnostic]', diagnosticFor(type, value));
}
