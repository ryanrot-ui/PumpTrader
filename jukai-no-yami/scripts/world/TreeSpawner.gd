extends Node3D

# ─── Tree Spawner v6 — PBR Aokigahara Trees with Trunk Collision ─────────────
# Organic trunks built with SurfaceTool. One StaticBody3D holds all trunk
# capsule colliders so static physics cost is minimal on Intel i3.
# Lean is kept subtle so trees look rooted, not falling over.

@export var count: int = 200
@export var area_size: Vector2 = Vector2(80.0, 80.0)
@export var min_scale: float = 2.0
@export var max_scale: float = 4.0
@export var avoid_center_radius: float = 6.0
@export var avoid_path_width: float = 0.0
@export var random_seed: int = 42
@export var cluster_count: int = 10
@export var cluster_radius: float = 9.0
@export var cluster_density: float = 0.72
@export var spawn_collision: bool = true

var _bark_mat: ShaderMaterial
var _foliage_mat: ShaderMaterial

func _ready() -> void:
	_bark_mat    = ShaderMaterial.new()
	_bark_mat.shader = load("res://shaders/bark.gdshader")

	_foliage_mat = ShaderMaterial.new()
	_foliage_mat.shader = load("res://shaders/foliage.gdshader")

	var mmi = MultiMeshInstance3D.new()
	add_child(mmi)
	var mm = MultiMesh.new()
	mm.transform_format = MultiMesh.TRANSFORM_3D
	mm.mesh = _make_tree_mesh()

	var rng = RandomNumberGenerator.new()
	rng.seed = random_seed

	# Cluster centres for dense groupings
	var clusters: Array = []
	for _c in cluster_count:
		var angle = rng.randf_range(0.0, TAU)
		var dist  = rng.randf_range(area_size.x * 0.22, area_size.x * 0.46)
		clusters.append(Vector2(cos(angle) * dist, sin(angle) * dist))

	# Collect tree positions and transforms
	var placed_positions: Array = []   # each entry: [x, z, sv]
	var transforms: Array = []         # Transform3D per placed tree

	var placed = 0
	for _i in count * 8:
		if placed >= count:
			break
		var x: float; var z: float
		if rng.randf() < cluster_density and clusters.size() > 0:
			var base: Vector2 = clusters[rng.randi() % clusters.size()]
			x = base.x + rng.randf_range(-cluster_radius, cluster_radius)
			z = base.y + rng.randf_range(-cluster_radius, cluster_radius)
		else:
			x = rng.randf_range(-area_size.x * 0.5, area_size.x * 0.5)
			z = rng.randf_range(-area_size.y * 0.5, area_size.y * 0.5)
		if Vector2(x, z).length() < avoid_center_radius:
			continue
		if abs(x) > area_size.x * 0.5 or abs(z) > area_size.y * 0.5:
			continue
		if avoid_path_width > 0 and abs(x) < avoid_path_width:
			continue

		var sv = rng.randf_range(min_scale, max_scale)
		var ry = rng.randf_range(0.0, TAU)

		# Subtle lean — max 0.025 rad random, 0.08 rad path-edge arch
		var lean_z = rng.randf_range(-0.025, 0.025)
		var lean_x = rng.randf_range(-0.018, 0.018)

		# Path-edge trees lean gently inward — creates a natural arching tunnel
		if avoid_path_width > 0.0 and abs(x) > avoid_path_width:
			var path_dist = abs(x) - avoid_path_width
			if path_dist < avoid_path_width * 3.0:
				var t = path_dist / (avoid_path_width * 3.0)
				lean_z += sign(x) * lerpf(0.08, 0.02, t)

		var xb = Basis.IDENTITY
		xb = xb.rotated(Vector3.UP, ry)
		xb = xb.rotated(Vector3(0, 0, 1), lean_z)
		xb = xb.rotated(Vector3(1, 0, 0), lean_x)
		xb = xb.scaled(Vector3(sv, sv, sv))

		transforms.append(Transform3D(xb, Vector3(x, 0, z)))
		placed_positions.append([x, z, sv])
		placed += 1

	# Set exact instance count — no degenerate zero-scale instances left over
	mm.instance_count = placed
	for i in placed:
		mm.set_instance_transform(i, transforms[i])

	mmi.multimesh = mm
	# Visibility was capped at 58 m — that's why playtest screenshots show
	# the path "ending" in pitch black: trees past 58 m got culled. Push it
	# out so the player sees a continuous wall of silhouettes down the path,
	# and use FADE_SELF so the cull edge softens instead of popping.
	mmi.visibility_range_end        = 140.0
	mmi.visibility_range_end_margin = 24.0
	mmi.visibility_range_fade_mode  = GeometryInstance3D.VISIBILITY_RANGE_FADE_SELF
	mmi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_ON \
		if GameManager.use_tree_shadows() \
		else GeometryInstance3D.SHADOW_CASTING_SETTING_OFF

	# ── Trunk collision bodies ────────────────────────────────────────────────
	# Single StaticBody3D with one CapsuleShape3D per tree trunk.
	# Much cheaper than one StaticBody3D per tree (one Broadphase AABB instead of N).
	if spawn_collision and placed_positions.size() > 0:
		var col_body = StaticBody3D.new()
		col_body.name = "TreeColliders"
		add_child(col_body)
		for tp in placed_positions:
			var tx: float = tp[0]
			var tz: float = tp[1]
			var tsv: float = tp[2]
			# Capsule sized to cover the lower trunk (avoidance zone for player)
			var cs = CapsuleShape3D.new()
			cs.radius = clampf(0.16 * tsv, 0.10, 0.52)
			cs.height = 2.6 * tsv    # cylinder portion height
			# Total height = 2.6*sv + 2*0.16*sv = 2.92*sv; half = 1.46*sv
			# So bottom of capsule = center_y - 1.46*sv = 0 → center_y = 1.46*sv
			var cshape = CollisionShape3D.new()
			cshape.shape = cs
			cshape.position = Vector3(tx, 1.46 * tsv, tz)
			col_body.add_child(cshape)

# ─── Tree Mesh ────────────────────────────────────────────────────────────────

func _make_tree_mesh() -> ArrayMesh:
	var am = ArrayMesh.new()

	# ── Surface 0: Tall thin trunks — dark silhouettes in fog ─────────────────
	var st = SurfaceTool.new()
	st.begin(Mesh.PRIMITIVE_TRIANGLES)

	_add_cyl(st, 10, Vector3(0.0, 0.0, 0.0), Vector3(0.035, 2.8, -0.02), 0.09, 0.07, 0.14)
	_add_cyl(st, 9, Vector3(0.035, 2.8, -0.02), Vector3(-0.02, 5.5, 0.02), 0.07, 0.04, 0.12)
	_add_cyl(st, 8, Vector3(-0.02, 5.5, 0.02), Vector3(0.01, 8.8, -0.01), 0.04, 0.015, 0.08)
	_add_cyl(st, 7, Vector3(0.02, 4.2, 0.0), Vector3(0.55, 5.8, 0.35), 0.025, 0.008, 0.08)
	_add_cyl(st, 7, Vector3(-0.02, 4.5, 0.0), Vector3(-0.5, 6.0, -0.3), 0.022, 0.007, 0.08)

	st.commit(am)
	am.surface_set_material(0, _bark_mat)

	# ── Surface 1: Solid canopy blobs ─────────────────────────────────────────
	# Was crossed billboard planes — the alpha-discard in the foliage
	# shader created the "paper cutout" look in playtest screenshots when
	# you looked up at the canopy. Replaced with solid icosahedral blobs
	# (flattened SphereMesh slices) so the canopy reads as proper 3D mass.
	var sf = SurfaceTool.new()
	sf.begin(Mesh.PRIMITIVE_TRIANGLES)

	_add_canopy_blob(sf, Vector3( 0.00, 8.4,  0.00), 1.45, 0.78)
	_add_canopy_blob(sf, Vector3( 0.45, 7.6,  0.30), 1.10, 0.62)
	_add_canopy_blob(sf, Vector3(-0.50, 7.7, -0.35), 1.05, 0.60)
	_add_canopy_blob(sf, Vector3( 0.10, 6.9,  0.00), 0.85, 0.50)

	sf.commit(am)
	am.surface_set_material(1, _foliage_mat)

	return am

# ─── Geometry helpers ─────────────────────────────────────────────────────────

func _pv(i: int, seed_val: float) -> float:
	var v = sin(float(i) * 127.1 + seed_val) * 43758.5453
	return (v - floor(v)) - 0.5

func _add_cyl(st: SurfaceTool, sides: int, a: Vector3, b: Vector3,
		r_a: float, r_b: float, perturb: float = 0.0) -> void:
	if (b - a).length() < 0.001:
		return
	var axis = (b - a).normalized()
	var perp = Vector3(0, 1, 0)
	if abs(axis.dot(perp)) > 0.9:
		perp = Vector3(1, 0, 0)
	var right = axis.cross(perp).normalized()
	var fwd   = right.cross(axis).normalized()

	for i in sides:
		var t0 = float(i)     / sides * TAU
		var t1 = float(i + 1) / sides * TAU
		var c0 = cos(t0); var s0 = sin(t0)
		var c1 = cos(t1); var s1 = sin(t1)
		var pr_a0 = r_a * (1.0 + _pv(i,     r_a * 100.0) * perturb)
		var pr_a1 = r_a * (1.0 + _pv(i + 1, r_a * 100.0) * perturb)
		var pr_b0 = r_b * (1.0 + _pv(i,     r_b * 100.0 + 1.0) * perturb)
		var pr_b1 = r_b * (1.0 + _pv(i + 1, r_b * 100.0 + 1.0) * perturb)
		var pa0 = a + (right * c0 + fwd * s0) * pr_a0
		var pa1 = a + (right * c1 + fwd * s1) * pr_a1
		var pb0 = b + (right * c0 + fwd * s0) * pr_b0
		var pb1 = b + (right * c1 + fwd * s1) * pr_b1
		# Per-vertex smooth normals — makes trunks look round, not faceted
		var n0 = (right * c0 + fwd * s0).normalized()
		var n1 = (right * c1 + fwd * s1).normalized()
		st.set_normal(n0); st.add_vertex(pa0)
		st.set_normal(n1); st.add_vertex(pa1)
		st.set_normal(n1); st.add_vertex(pb1)
		if r_a > 0.005:
			st.set_normal(n0); st.add_vertex(pa0)
			st.set_normal(n1); st.add_vertex(pb1)
			st.set_normal(n0); st.add_vertex(pb0)

	if r_b > 0.005:
		st.set_normal(axis)
		for i in sides:
			var t0 = float(i)     / sides * TAU
			var t1 = float(i + 1) / sides * TAU
			st.add_vertex(b)
			st.add_vertex(b + (right * cos(t0) + fwd * sin(t0)) * r_b)
			st.add_vertex(b + (right * cos(t1) + fwd * sin(t1)) * r_b)

func _add_root_fin(st: SurfaceTool, dir: Vector3) -> void:
	var base_in  = dir * 0.12
	var base_out = dir * 0.72
	var top      = dir * 0.14 + Vector3(0, 0.75, 0)
	var n = dir.cross(Vector3.UP).normalized()
	if n.length() < 0.01:
		n = Vector3(1, 0, 0)
	st.set_normal( n); st.add_vertex(base_in); st.add_vertex(base_out); st.add_vertex(top)
	st.set_normal(-n); st.add_vertex(base_in); st.add_vertex(top); st.add_vertex(base_out)
	var mid = (base_in + top) * 0.5 + dir * 0.08
	st.set_normal( n); st.add_vertex(base_in); st.add_vertex(top); st.add_vertex(mid)
	st.set_normal(-n); st.add_vertex(base_in); st.add_vertex(mid); st.add_vertex(top)

# Crossed billboard planes — 4 planes at 45° intervals fill the volume in all
# directions. cull_disabled in the foliage shader renders both faces so every
# plane is visible from the full 360°. The noise mask in the shader punches
# organic leaf silhouettes through each plane.
func _add_leaf_cluster(sf: SurfaceTool, center: Vector3, radius: float, height: float) -> void:
	# Legacy crossed-billboard cluster — no longer used (replaced by
	# _add_canopy_blob below) but kept as a reference. Calling code uses
	# the blob version which renders as solid 3D mass instead of the
	# alpha-discard "paper cutout" look that showed up in playtests.
	for i in 2:
		var angle = float(i) / 2.0 * PI
		var right = Vector3(cos(angle), 0.0, sin(angle)) * radius
		var n     = Vector3(-sin(angle), 0.0, cos(angle))  # perpendicular in XZ
		var bot   = -height * 0.28
		var top   =  height * 0.72
		var bl = center + Vector3(-right.x, bot, -right.z)
		var br = center + Vector3( right.x, bot,  right.z)
		var v_top_r = center + Vector3( right.x, top,  right.z)
		var v_top_l = center + Vector3(-right.x, top, -right.z)
		sf.set_normal(n)
		sf.add_vertex(bl); sf.add_vertex(br); sf.add_vertex(v_top_r)
		sf.add_vertex(bl); sf.add_vertex(v_top_r); sf.add_vertex(v_top_l)


# Solid canopy blob — a flattened icosphere built by stacked latitude rings.
# Reads as a proper 3D dark silhouette mass from any angle, no alpha discard,
# no flat 2D edges. Squish ratio < 1.0 flattens it horizontally so the
# canopy looks like layered foliage instead of a perfect sphere.
func _add_canopy_blob(sf: SurfaceTool, center: Vector3, radius: float, squish: float) -> void:
	var rings: int = 6
	var segments: int = 10
	# Pre-compute ring points
	var ring_points: Array = []
	for r in range(rings + 1):
		var phi: float = float(r) / float(rings) * PI
		var y: float = cos(phi) * radius * squish
		var ring_r: float = sin(phi) * radius
		var row: Array = []
		for s in range(segments + 1):
			var theta: float = float(s) / float(segments) * TAU
			var x: float = cos(theta) * ring_r
			var z: float = sin(theta) * ring_r
			# Slight per-vertex bumpiness so the blob isn't a perfect sphere
			var jitter: float = sin(theta * 5.0 + phi * 3.0) * 0.08 * radius
			row.append(Vector3(x + jitter * cos(theta), y, z + jitter * sin(theta)))
		ring_points.append(row)
	# Build triangle faces between rings — solid surface, smooth normals.
	for r in range(rings):
		for s in range(segments):
			var p00: Vector3 = ring_points[r][s] + center
			var p01: Vector3 = ring_points[r][s + 1] + center
			var p10: Vector3 = ring_points[r + 1][s] + center
			var p11: Vector3 = ring_points[r + 1][s + 1] + center
			# Two triangles per quad — outward normals via cross product
			var n0: Vector3 = ((p10 - p00).cross(p01 - p00)).normalized()
			var n1: Vector3 = ((p11 - p01).cross(p10 - p01)).normalized()
			sf.set_normal(n0)
			sf.add_vertex(p00); sf.add_vertex(p10); sf.add_vertex(p01)
			sf.set_normal(n1)
			sf.add_vertex(p01); sf.add_vertex(p10); sf.add_vertex(p11)
