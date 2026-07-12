export type RgbaColor = [number, number, number, number];

function readCustomProperties(source: string): Map<string, string> {
  const properties = new Map<string, string>();
  for (const [, name, value] of source.matchAll(/^\s*(--[\w-]+)\s*:\s*([\s\S]*?);/gm)) {
    properties.set(name, value.trim());
  }
  return properties;
}

function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "(") depth += 1;
    if (value[index] === ")") depth -= 1;
    if (value[index] === "," && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts;
}

function mix(left: RgbaColor, right: RgbaColor, leftWeight: number, rightWeight: number): RgbaColor {
  const total = leftWeight + rightWeight;
  const alphaMultiplier = total < 1 ? total : 1;
  const normalizedLeft = total === 0 ? 0.5 : leftWeight / total;
  const normalizedRight = total === 0 ? 0.5 : rightWeight / total;
  const alpha = (left[3] * normalizedLeft + right[3] * normalizedRight) * alphaMultiplier;
  if (alpha === 0) return [0, 0, 0, 0];

  return [
    (left[0] * left[3] * normalizedLeft + right[0] * right[3] * normalizedRight) / (alpha / alphaMultiplier),
    (left[1] * left[3] * normalizedLeft + right[1] * right[3] * normalizedRight) / (alpha / alphaMultiplier),
    (left[2] * left[3] * normalizedLeft + right[2] * right[3] * normalizedRight) / (alpha / alphaMultiplier),
    alpha,
  ];
}

export function resolveCssColor(source: string, token: string): RgbaColor {
  const properties = readCustomProperties(source);

  function resolve(value: string, stack: Set<string>): RgbaColor {
    const expression = value.trim();
    if (expression === "transparent") return [0, 0, 0, 0];
    if (expression === "black") return [0, 0, 0, 1];
    if (expression === "white") return [255, 255, 255, 1];

    const hex = expression.match(/^#([0-9a-f]{3,8})$/i)?.[1];
    if (hex) {
      const expanded = hex.length === 3 || hex.length === 4
        ? [...hex].map((character) => `${character}${character}`).join("")
        : hex;
      return [
        Number.parseInt(expanded.slice(0, 2), 16),
        Number.parseInt(expanded.slice(2, 4), 16),
        Number.parseInt(expanded.slice(4, 6), 16),
        expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1,
      ];
    }

    const rgb = expression.match(/^rgba?\(([^)]+)\)$/i);
    if (rgb) {
      const parts = rgb[1].split(/[,\s/]+/).filter(Boolean).map(Number);
      return [parts[0], parts[1], parts[2], parts[3] ?? 1];
    }

    const variable = expression.match(/^var\((--[\w-]+)(?:,\s*([\s\S]+))?\)$/);
    if (variable) {
      const [, name, fallback] = variable;
      if (stack.has(name)) throw new Error(`Cyclic CSS color reference: ${[...stack, name].join(" -> ")}`);
      const definition = properties.get(name) ?? fallback;
      if (!definition) throw new Error(`Missing CSS color reference ${name}`);
      return resolve(definition, new Set([...stack, name]));
    }

    const colorMix = expression.match(/^color-mix\(in srgb,\s*([\s\S]+)\)$/i);
    if (colorMix) {
      const terms = splitTopLevel(colorMix[1]);
      if (terms.length !== 2) throw new Error(`Unsupported color-mix expression ${expression}`);
      const parsed = terms.map((term) => {
        const percentage = term.match(/\s+([\d.]+)%$/);
        return {
          color: resolve(percentage ? term.slice(0, percentage.index).trim() : term, stack),
          weight: percentage ? Number(percentage[1]) / 100 : null,
        };
      });
      const leftWeight = parsed[0].weight ?? (parsed[1].weight === null ? 0.5 : 1 - parsed[1].weight);
      const rightWeight = parsed[1].weight ?? (parsed[0].weight === null ? 0.5 : 1 - parsed[0].weight);
      return mix(parsed[0].color, parsed[1].color, leftWeight, rightWeight);
    }

    throw new Error(`Unsupported CSS color ${expression}`);
  }

  const value = properties.get(token);
  if (!value) throw new Error(`Missing ${token}`);
  return resolve(value, new Set([token]));
}
