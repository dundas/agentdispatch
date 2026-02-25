const NO_COLOR = 'NO_COLOR' in process.env;

function green(s: string): string  { return NO_COLOR ? s : `\x1b[32m${s}\x1b[0m`; }
function yellow(s: string): string { return NO_COLOR ? s : `\x1b[33m${s}\x1b[0m`; }
function red(s: string): string    { return NO_COLOR ? s : `\x1b[31m${s}\x1b[0m`; }
function cyan(s: string): string   { return NO_COLOR ? s : `\x1b[36m${s}\x1b[0m`; }
function bold(s: string): string   { return NO_COLOR ? s : `\x1b[1m${s}\x1b[0m`; }
function dim(s: string): string    { return NO_COLOR ? s : `\x1b[2m${s}\x1b[0m`; }

export function isJsonMode(): boolean {
  return process.argv.includes('--json') || process.env.ADMP_JSON === '1';
}

export function success(msg: string, data?: unknown): void {
  if (isJsonMode()) {
    console.log(JSON.stringify(data ?? { message: msg }));
    return;
  }
  console.log(green('✓') + ' ' + msg);
  if (data !== undefined) {
    console.log(JSON.stringify(data, null, 2));
  }
}

export function warn(msg: string): void {
  if (isJsonMode()) {
    process.stderr.write(JSON.stringify({ warning: msg }) + '\n');
    return;
  }
  console.warn(yellow('⚠') + ' ' + msg);
}

export function error(msg: string, code?: string): void {
  if (isJsonMode()) {
    process.stderr.write(JSON.stringify({ error: msg, code: code ?? 'ERROR' }) + '\n');
    return;
  }
  const prefix = code ? red(`${code}:`) + ' ' : red('Error:') + ' ';
  process.stderr.write(prefix + msg + '\n');
}

export function maskSecret(value: string | undefined): string {
  if (!value) return '(not set)';
  return value.length <= 8 ? '***' : value.slice(0, 8) + '...';
}

export function json(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

export function printMessage(envelope: Record<string, unknown>): void {
  if (isJsonMode()) {
    console.log(JSON.stringify(envelope, null, 2));
    return;
  }
  console.log('');
  console.log(bold('Message') + ' ' + dim(String(envelope.id ?? '')));
  console.log(dim('─'.repeat(60)));
  console.log(`  ${cyan('from')}:    ${envelope.from ?? ''}`);
  console.log(`  ${cyan('to')}:      ${envelope.to ?? ''}`);
  console.log(`  ${cyan('type')}:    ${envelope.type ?? ''}`);
  console.log(`  ${cyan('subject')}: ${envelope.subject ?? ''}`);
  if (envelope.correlation_id) {
    console.log(`  ${cyan('corr_id')}: ${envelope.correlation_id}`);
  }
  if (envelope.lease_until) {
    console.log(`  ${cyan('lease')}:   ${envelope.lease_until}`);
  }
  if (envelope.attempts !== undefined) {
    console.log(`  ${cyan('attempts')}: ${envelope.attempts}`);
  }
  console.log('');
  console.log(bold('Body:'));
  console.log(JSON.stringify(envelope.body, null, 2));
  console.log('');
}
