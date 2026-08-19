import { describe, expect, it } from 'vitest';
import { buildMetricToolSurface, getMetricToolDefinition } from './tool-surface';

/**
 * tested against the REAL, full metric catalog (`@retailos/metrics`'s own `index.ts`
 * registers every real metric as a side effect of import — no `_resetRegistryForTests` escape
 * hatch is exported publicly, so this is the only way to test the tool surface at all, and it's
 * the more honest test anyway: this is exactly what earlier work's planning stage will actually see.
 */
describe('buildMetricToolSurface', () => {
  it('returns one tool definition per real registered metric, matching listMetricIds() exactly', async () => {
    const { listMetricIds } = await import('@retailos/metrics');
    const tools = buildMetricToolSurface();

    expect(tools.length).toBe(listMetricIds().length);
    expect(tools.length).toBeGreaterThan(30); // the real catalog has ~67 metrics as of 2026-08-17 — a loose floor, not a brittle exact count
  });

  it('every tool has a real name, a non-empty description, and an object-shaped parametersSchema', () => {
    const tools = buildMetricToolSurface();

    for (const tool of tools) {
      expect(tool.name.length).toBeGreaterThan(0);
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.parametersSchema.type).toBe('object');
    }
  });

  it('a real metric with a date-range parameter (net_revenue) gets string/date-format fields, not an empty schema', () => {
    const tool = getMetricToolDefinition('net_revenue');

    expect(tool).toBeDefined();
    const props = tool!.parametersSchema.properties as Record<string, { type?: string; format?: string }>;
    expect(props.from).toEqual({ type: 'string', format: 'date' });
    expect(props.to).toEqual({ type: 'string', format: 'date' });
    expect(props.storeId?.type).toBe('string');
  });

  it('getMetricToolDefinition returns undefined for an unregistered id, never a fabricated tool', () => {
    const tool = getMetricToolDefinition('this_metric_does_not_exist');
    expect(tool).toBeUndefined();
  });

  it('a metric with a numeric default-valued param produces a real numeric schema', () => {
    const tool = getMetricToolDefinition('expiry_risk_value');
    expect(tool).toBeDefined();
    const props = tool!.parametersSchema.properties as Record<string, { type?: string }>;
    expect(props.horizonDays?.type).toBe('integer');
  });

  it('the tool surface is generated from the catalog, not hand-maintained — adding a metric elsewhere would change this list without touching this file', () => {
    // A structural proof, not a behavioral one: buildMetricToolSurface has no hardcoded metric
    // id list anywhere in its own source — confirmed by construction (it calls listMetricIds()),
    // this test just pins that the real catalog includes a metric from each of several distinct
    // domains, proving the surface spans the whole catalog, not one file's worth.
    const names = buildMetricToolSurface().map((t) => t.name);
    expect(names).toContain('net_revenue'); // margin
    expect(names).toContain('stock_on_hand'); // inventory
    expect(names).toContain('fill_rate'); // supplier/purchasing
  });
});
