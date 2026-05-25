// Canopy blob shader — flat-shaded dark green mass with a procedural
// texture-noise variation so the surface doesn't read as plastic.
//
// Previous version used alpha-discard against a 2D crossed-billboard
// mesh which created the "paper cutout" silhouette visible in playtest
// screenshots. The geometry is now solid 3D blobs (see TreeSpawner
// _add_canopy_blob) so we draw OPAQUELY and modulate colour by noise.
shader_type spatial;
render_mode cull_disabled, unshaded;

uniform vec4 canopy_color : source_color = vec4(0.014, 0.022, 0.012, 1.0);
uniform vec4 edge_color   : source_color = vec4(0.038, 0.046, 0.028, 1.0);
// Wind strength — applied only to the top of the canopy.
uniform float wind_str    : hint_range(0.0, 0.1) = 0.010;
// Grain noise contribution. 0 = flat colour, 1 = full noise variance.
uniform float grain_amount : hint_range(0.0, 1.0) = 0.45;

varying vec3 wpos;

float h2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

float n2(vec2 p) {
	vec2 i = floor(p); vec2 f = fract(p);
	f = f * f * (3.0 - 2.0 * f);
	return mix(mix(h2(i), h2(i + vec2(1, 0)), f.x),
	           mix(h2(i + vec2(0, 1)), h2(i + vec2(1, 1)), f.x), f.y);
}

void vertex() {
	wpos = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz;
	float phase = wpos.x * 0.4 + wpos.z * 0.35;
	float sway = sin(TIME * 0.9 + phase) * wind_str;
	// Hem-weighted: only the upper canopy (VERTEX.y > 4) actually sways
	float hfac = max(0.0, VERTEX.y - 4.0) * 0.15;
	VERTEX.x += sway * hfac;
	VERTEX.z += sway * hfac * 0.4;
}

void fragment() {
	// Two-octave noise — chunky base mass + finer surface variation
	float n_base = n2(wpos.xz * 1.2 + wpos.y * 0.3);
	float n_fine = n2(wpos.xz * 5.5 + wpos.y * 1.8);
	float n = n_base * 0.65 + n_fine * 0.35;
	// Mix between the deep canopy colour and the slightly lighter edge
	// colour by the noise value. Result: solid 3D mass with organic
	// surface variation, no transparency, no jagged 2D edges.
	vec3 col = mix(canopy_color.rgb, edge_color.rgb, n * grain_amount);
	ALBEDO = col;
	ROUGHNESS = 1.0;
}
