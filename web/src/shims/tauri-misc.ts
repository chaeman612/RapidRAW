/**
 * Browser replacements for the smaller Tauri modules:
 * @tauri-apps/api/app, @tauri-apps/api/path, @tauri-apps/plugin-os,
 * @tauri-apps/plugin-process, @tauri-apps/plugin-shell, @tauri-apps/plugin-http,
 * tauri-plugin-clerk.
 */
import pkg from '../../../src-tauri/tauri.conf.json';
import { isMobileUi } from '../platform';

// app
export async function getVersion() {
  return `${(pkg as any).version ?? '0.0.0'}-web`;
}
export async function getName() {
  return 'RapidRAW Web';
}
export async function getTauriVersion() {
  return 'web';
}

// path
export async function homeDir() {
  return '/';
}
export async function appDataDir() {
  return '/AppData';
}
export async function appLocalDataDir() {
  return '/AppData';
}
export async function documentDir() {
  return '/';
}
export async function pictureDir() {
  return '/';
}
export async function downloadDir() {
  return '/Downloads';
}
export async function join(...parts: string[]) {
  return parts.join('/').replace(/\/+/g, '/');
}
export const sep = () => '/';

// os
/** "android" selects RapidRAW's touch layout on phones/tablets (see platform.ts). */
export function platform() {
  return isMobileUi ? 'android' : 'web';
}
export function type() {
  return 'web';
}
export function arch() {
  return 'wasm32';
}
export function version() {
  return navigator.userAgent;
}
export function locale() {
  return Promise.resolve(navigator.language);
}

// process
export async function relaunch() {
  window.location.reload();
}
export async function exit() {
  window.close();
}

// shell
export async function open(target: string) {
  window.open(target, '_blank', 'noopener');
}
export class Command {
  static create() {
    return { execute: async () => ({ code: 1, stdout: '', stderr: 'Not available in the browser' }) };
  }
}

// http
export const fetch: typeof window.fetch = (...args) => window.fetch(...args);

// clerk (cloud sign-in is not wired up for the web build)
export async function initClerk() {
  throw new Error('Cloud sign-in is not available in RapidRAW Web yet.');
}
