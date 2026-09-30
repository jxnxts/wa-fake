import { validateFlowJson } from 'flowso/validator';
import { COMPONENT_MIN_VERSION, compareVersions } from 'flowso/schema';
import type { Json } from '../../core/src/contracts.ts';

export const isObject = (value: unknown): value is Json =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const issue = (error: string, message: string, path: string) => ({
  error,
  error_type: 'FLOW_JSON_ERROR',
  message,
  severity: 'error',
  pointers: [{ path }],
});

export function validateAsset(value: unknown): { errors: Json[]; unsupported: boolean } {
  const errors: Json[] = [];
  let unsupported = false;
  if (
    isObject(value) &&
    typeof value.version === 'string' &&
    (compareVersions(value.version, '4.0') < 0 || compareVersions(value.version, '7.3') > 0)
  ) {
    errors.push(
      issue(
        'UNSUPPORTED_VERSION',
        'Local runtime supports Flow JSON versions 4.0 through 7.3',
        'version',
      ),
    );
    unsupported = true;
  }
  function walk(item: unknown, path: string): void {
    if (Array.isArray(item)) {
      item.forEach((value, i) => walk(value, `${path}[${i}]`));
      return;
    }
    if (!isObject(item)) return;
    if (
      typeof item.type === 'string' &&
      path.includes('layout') &&
      !['SingleColumnLayout', 'screen'].includes(item.type)
    ) {
      if (
        !(item.type in COMPONENT_MIN_VERSION) ||
        ['PhotoPicker', 'DocumentPicker', 'NavigationList'].includes(item.type)
      ) {
        errors.push(
          issue('UNSUPPORTED_COMPONENT', `not_implemented: component ${item.type}`, `${path}.type`),
        );
        unsupported = true;
      }
    }
    for (const [key, value] of Object.entries(item)) walk(value, `${path}.${key}`);
  }
  if (isObject(value)) walk(value.screens, 'screens');
  try {
    errors.push(...validateFlowJson(value).issues.filter((issue) => issue.severity === 'error'));
  } catch {
    errors.push(issue('INVALID_PROPERTY_VALUE', 'Malformed Flow JSON structure', '$'));
  }
  return { errors, unsupported };
}

/** Endpoint responses must provide the declared data; production never fills __example__. */
export function checkScreenData(flow: Json, screenId: string, data: unknown): void {
  if (!isObject(data)) throw new Error('Invalid screen data');
  const screen = flow.screens.find((s: Json) => s.id === screenId);
  if (!screen) throw new Error('Unknown screen');
  function check(value: unknown, declaration: Json): void {
    const type = declaration.type;
    const valid =
      type === 'array'
        ? Array.isArray(value)
        : type === 'object'
          ? isObject(value)
          : type === 'number'
            ? typeof value === 'number' && Number.isFinite(value)
            : typeof value === type;
    if (!valid) throw new Error('Screen data type mismatch');
    if (Array.isArray(value) && isObject(declaration.items))
      for (const item of value) check(item, declaration.items);
    if (isObject(value) && isObject(declaration.properties))
      for (const [key, spec] of Object.entries(declaration.properties))
        if (Object.hasOwn(value, key)) check(value[key], spec);
  }
  for (const [name, spec] of Object.entries(screen.data ?? {})) check(data[name], spec as Json);
}
