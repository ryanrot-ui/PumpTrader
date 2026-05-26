shader_type spatial;
// ─── Flashlight Volumetric Cone — v2 ────────────────────────────────────
// Applied to a ConeMesh (a CylinderMesh with top_radius = 0) parented to
// the player's SpotLight3D. Renders a semi-transparent dust-illuminated
// cone that simulates light scattering through the air, without using
// Godot's real volumetric fog (banned for performance).
//
// Render-mode reasoning:
//   blend_add              — additive: bright wherever the cone is, never darkens
//   depth_draw_never       — never writes depth, so the cone doesn't occlude things
//   cull_front             — render BACK faces so the player can see the
//                            volume from inside the cone (cone tip is at camera)
//   unshaded               — no PBR lighting on the cone itself
//   ambient_light_disabled — independent of scene ambient
//   shadows_disabled       — no shadow contribution

render_mode blend_add, depth_draw_never, cull_front, unshaded, shadows_disabled, ambient_light_disabled;

// Cone tint — slightly warm yellow-white, matches the player's SpotLight3D.
uniform vec4  beam_color     : source_color = vec4(0.92, 0.85, 0.70, 1.0);
// Overall opacity / "haze thickness".
uniform float density        : hint_range(0.0, 1.0)  = 0.32;
// Dust scrolling speed (lower = stiller, higher = wilder).
uniform float dust_speed     : hint_range(0.0, 3.0)  = 0.45;
// Dust mote scale — higher = finer specks, lower = chunky clouds.
uniform float dust_scale     : hint_range(1.0, 30.0) = 14.0;
// Soft-edge fade radius near the cone's base + tip. Larger = softer.
uniform float proximity_fade : hint_range(0.05, 1.0) = 0.35;
// Random flickering amplitude — Flashlight.gd drives this from low-sanity.
uniform float flicker_amount : hint_range(0.0, 1.0)  = 0.10;

// Cheap 3-channel hash — used for both noise lookup and the flicker pulse.
float hash13(vec3 p) {
	p = fract(p * vec3(443.8975, 397.2973, 491.1871));
	p += dot(p, p.yxz + 19.19);
	return fract((p.x + p.y) * p.z);
}

// 3D trilinear value noise — interpolates between hashed lattice points.
// One swirl in TIME by feeding sin/cos products into the lattice space so
// the dust pattern rotates instead of just sliding.
float noise3(vec3 p) {
	vec3 i = floor(p);
	vec3 f = fract(p);
	f = f * f * (3.0 - 2.0 * f);
	return mix(
		mix(mix(hash13(i),                hash13(i + vec3(1.0, 0.0, 0.0)), f.x),
		    mix(hash13(i + vec3(0,1,0)),  hash13(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
		mix(mix(hash13(i + vec3(0,0,1)),  hash13(i + vec3(1.0, 0.0, 1.0)), f.x),
		    mix(hash13(i + vec3(0,1,1)),  hash13(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
}

void fragment() {
	// Cone UV convention:
	//   UV.y = 0 at cone TIP (closest to the lens / camera)
	//   UV.y = 1 at cone BASE (far end of the beam)
	//   UV.x wraps 0..1 around the circumference
	float along  = UV.y;
	float radial = abs(UV.x * 2.0 - 1.0);   // 0 = central axis, 1 = side wall

	// ── Depth fade ─────────────────────────────────────────────────────────
	// Bright near the lens (close particles catch light), darker at the far
	// end (less density visible at distance). Custom curve avoids the harsh
	// "lit ring on the ground" the user described.
	float near_fade = pow(1.0 - along, 0.6) * 0.65;
	float far_fade  = pow(along,         1.4) * 0.10;
	float depth_fade = near_fade + far_fade;

	// ── Radial / proximity edge fade ───────────────────────────────────────
	// Soft falloff toward the cone's outer wall so the silhouette doesn't
	// read as a hard cylinder edge against the floor. proximity_fade scales
	// how soft the wall is.
	float edge_fade = pow(1.0 - radial, 1.6 - proximity_fade);
	// Additional tip-clip: smoothly fade out the first 8% of the cone so the
	// flashlight lens doesn't have a visible cone "stub" right at the player.
	float tip_clip = smoothstep(0.0, 0.08, along);
	// Base-clip: fade out the last 6% so the cone doesn't end in a hard disc.
	float base_clip = 1.0 - smoothstep(0.94, 1.0, along);

	// ── Swirling dust ──────────────────────────────────────────────────────
	// Sample 3D noise with a TIME-driven rotation in the UV plane. The sin/
	// cos pair spins the lookup so dust motes orbit the beam axis instead
	// of just translating linearly.
	float t = TIME * dust_speed;
	float ca = cos(t * 0.6);
	float sa = sin(t * 0.6);
	vec2 spun_uv = vec2(UV.x * ca - UV.y * sa, UV.x * sa + UV.y * ca);
	vec3 dust_uv = vec3(spun_uv * dust_scale, t * 1.3);
	float dust = noise3(dust_uv);
	// Two-octave for finer specks on top of the cloud blobs
	dust += noise3(dust_uv * 2.4 + vec3(7.1, 3.7, 1.3)) * 0.45;
	// Contrast curve — pushes faint noise toward the threshold, sharpens specks
	dust = smoothstep(0.30, 0.85, dust);

	// ── Flicker ────────────────────────────────────────────────────────────
	// Pseudo-random per-frame jitter via hash, plus a fast sine wobble so
	// the cone subtly breathes. flicker_amount comes from GDScript and
	// scales with low sanity for a haunted-handheld feel.
	float flicker_hash = hash13(vec3(floor(TIME * 17.0), 1.0, 1.0));
	float flicker = 1.0 - flicker_amount * (0.35 + 0.65 * flicker_hash) * (0.5 + 0.5 * sin(TIME * 22.0));

	// ── Compose ────────────────────────────────────────────────────────────
	float alpha = depth_fade * edge_fade * tip_clip * base_clip * density;
	alpha *= (0.55 + dust * 0.55);
	alpha *= flicker;
	// Clamp to a soft maximum so the additive blend doesn't blow out white.
	alpha = clamp(alpha, 0.0, 0.55);

	ALBEDO = beam_color.rgb;
	ALPHA  = alpha;
}
