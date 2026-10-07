// Generated from expo-hermes; edit the private source, not this mirror.
import { createHash, randomBytes } from "crypto";

const WORDS = [
  "KITE",
  "BIRD",
  "FISH",
  "WOLF",
  "BEAR",
  "DEER",
  "FROG",
  "HAWK",
  "LYNX",
  "MOLE",
  "NEWT",
  "ORCA",
  "PUMA",
  "RAIL",
  "SEAL",
  "TEAL",
  "VOLE",
  "WASP",
  "YARN",
  "ZINC",
  "APEX",
  "BOLT",
  "CAVE",
  "DUNE",
  "EDGE",
  "FLUX",
  "GLOW",
  "HAZE",
  "IRIS",
  "JADE",
  "KELP",
  "LAVA",
];

export function speakableToken(): string {
  const word = WORDS[randomBytes(1)[0] % WORDS.length];
  const a = (randomBytes(1)[0] % 9) + 1;
  const b = (randomBytes(1)[0] % 9) + 1;
  return `${a}-${word}-${b}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function apiKey(): string {
  return "hb_" + randomBytes(32).toString("hex");
}

export function inviteId(): string {
  return "inv_" + randomBytes(8).toString("hex");
}

// Pairing token used by both the QR flow and manual entry. Keep this in the
// speakable format so the code shown by the laptop can be typed into the app.
export function pairToken(): string {
  return speakableToken();
}
