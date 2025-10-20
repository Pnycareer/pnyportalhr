function normalizeBaseUrl(value) {
  if (!value) {
    return null;
  }
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function buildPublicBaseUrl() {
  const fromEnv = normalizeBaseUrl(process.env.PUBLIC_BASE_URL);
  if (fromEnv) {
    return fromEnv;
  }
  const port = process.env.PORT || 8000;
  return `http://localhost:${port}`;
}

function toPublicUrl(pathValue) {
  if (!pathValue) {
    return null;
  }
  if (/^https?:\/\//i.test(pathValue)) {
    return pathValue;
  }
  const baseUrl = buildPublicBaseUrl();
  const path = pathValue.startsWith("/") ? pathValue : `/${pathValue}`;
  return `${baseUrl}${path}`;
}

module.exports = {
  toPublicUrl,
};
