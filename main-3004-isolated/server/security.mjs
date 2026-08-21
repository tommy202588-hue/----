import dns from 'node:dns';
import net from 'node:net';

export class HttpError extends Error {
  constructor(statusCode, message, type = 'request_error') {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.type = type;
  }
}

export const parseHostPatterns = (value, defaults = []) => {
  const entries = String(value || '')
    .split(',')
    .map(entry => entry.trim().toLowerCase())
    .filter(Boolean);
  return entries.length ? entries : defaults;
};

export const matchesHostPattern = (hostname, pattern) => {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  const normalized = String(pattern || '').toLowerCase().replace(/\.$/, '');
  if (!host || !normalized) return false;
  if (normalized.startsWith('*.')) {
    const suffix = normalized.slice(1);
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  if (normalized.startsWith('.')) {
    const bare = normalized.slice(1);
    return host === bare || host.endsWith(normalized);
  }
  return host === normalized;
};

const parseIpv4 = address => {
  const parts = String(address).split('.');
  if (parts.length !== 4) return null;
  const values = parts.map(part => Number(part));
  if (values.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return null;
  return values;
};

const isPublicIpv4 = address => {
  const octets = parseIpv4(address);
  if (!octets) return false;
  const [a, b, c] = octets;

  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
};

const isPublicIpv6 = address => {
  const normalized = String(address).toLowerCase().split('%')[0];
  if (!normalized || normalized === '::' || normalized === '::1') return false;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return false;
  if (/^fe[89ab]/.test(normalized)) return false;
  if (normalized.startsWith('ff')) return false;
  if (normalized.startsWith('2001:db8:')) return false;

  const mapped = normalized.match(/^::ffff:(.+)$/);
  if (mapped) {
    if (mapped[1].includes('.')) return isPublicIpv4(mapped[1]);
    const parts = mapped[1].split(':');
    if (parts.length === 2 && parts.every(part => /^[0-9a-f]{1,4}$/.test(part))) {
      const high = Number.parseInt(parts[0], 16);
      const low = Number.parseInt(parts[1], 16);
      return isPublicIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
    return false;
  }
  return true;
};

export const isPublicIpAddress = address => {
  const family = net.isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
};

export const validateTargetUrl = async (rawUrl, patterns, lookup = dns.promises.lookup) => {
  let target;
  try {
    target = new URL(String(rawUrl || ''));
  } catch {
    throw new HttpError(400, 'Invalid target URL.', 'invalid_target_url');
  }

  if (target.protocol !== 'https:' || target.username || target.password) {
    throw new HttpError(400, 'Only credential-free HTTPS target URLs are allowed.', 'invalid_target_url');
  }

  const hostname = target.hostname.toLowerCase().replace(/\.$/, '');
  if (!patterns.some(pattern => matchesHostPattern(hostname, pattern))) {
    throw new HttpError(403, 'Target hostname is not allowed.', 'target_not_allowed');
  }

  if (net.isIP(hostname)) {
    if (!isPublicIpAddress(hostname)) {
      throw new HttpError(403, 'Private and reserved target addresses are not allowed.', 'private_target_blocked');
    }
    return target;
  }

  let addresses;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new HttpError(502, 'Target hostname could not be resolved.', 'target_dns_error');
  }

  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new HttpError(502, 'Target hostname did not resolve to an address.', 'target_dns_error');
  }
  if (addresses.some(entry => !isPublicIpAddress(entry.address))) {
    throw new HttpError(403, 'Target hostname resolves to a private or reserved address.', 'private_target_blocked');
  }

  target.hostname = hostname;
  return target;
};

export const createSafeLookup = patterns => async (hostname, options, callback) => {
  try {
    const target = await validateTargetUrl(`https://${hostname}/`, patterns);
    const results = await dns.promises.lookup(target.hostname, { all: true, verbatim: true });
    const selected = results.find(entry => entry.family === 4 && isPublicIpAddress(entry.address))
      || results.find(entry => isPublicIpAddress(entry.address));
    if (!selected) throw new Error('No public address is available for the target.');

    if (options?.all) {
      callback(null, [selected]);
    } else {
      callback(null, selected.address, selected.family);
    }
  } catch (error) {
    callback(error);
  }
};
