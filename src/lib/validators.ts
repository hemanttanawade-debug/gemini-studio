// Lightweight validators used in the Domain Configuration step.

const DOMAIN_RE = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const isValidDomain = (value: string) => DOMAIN_RE.test(value.trim());

export const isValidEmail = (value: string) => EMAIL_RE.test(value.trim());

export const emailMatchesDomain = (email: string, domain: string) => {
  const parts = email.trim().toLowerCase().split("@");
  if (parts.length !== 2) return false;
  return parts[1] === domain.trim().toLowerCase();
};
