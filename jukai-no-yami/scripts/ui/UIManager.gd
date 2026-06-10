extends CanvasLayer

const NOTE_JP = {0: "花子の手紙", 1: "壊れた方位磁針", 2: "日記の切れ端", 3: "最後の写真"}

# Player's inner voice after each pickup — tracks the arc: recognition →
# wrongness → dread → panic. Note 3's monologue lands the twist about
# the exit light.
const MONOLOGUE = {
	0: "This is Hanako's handwriting. She was ALIVE in here. And she wasn't alone.",
	1: "Her compass... I gave her this. Why is the needle still moving?",
	2: "'If you hear my voice, do not follow it.' Then whose voice led me this deep?",
	3: "Every face crossed out except mine. Mine is circled. That light isn't the way out — RUN ANYWAY.",
}

var sanity_bar: ProgressBar
var battery_bar: ProgressBar
var battery_icon: Label
var note_counter: Label
var note_notif: PanelContainer
var note_notif_lbl: Label
var note_reader: PanelContainer
var note_title_lbl: Label
var note_body_lbl: RichTextLabel
var pause_menu: Control
var vignette: ColorRect
var flash_overlay: ColorRect
var static_overlay: ColorRect
var halluc_overlay: ColorRect
var monologue_lbl: Label
var _cinematic_panel: PanelContainer
var _cinematic_lbl: RichTextLabel
var _area_card: PanelContainer
var _area_jp: Label
var _area_en: Label
var _area_sub: Label
var _subtitle_lbl: Label

func _ready() -> void:
	GameManager.ui_ref = self
	add_to_group("hud")
	_build_hud()
	_build_pause_menu()
	JumpscareSystem.jumpscare_fired.connect(_on_jumpscare_fired)
	GameManager.note_collected.connect(_on_note_collected)
	_refresh_note_counter()
	await get_tree().process_frame
	# Scene may have been swapped while we awaited — the HUD is detached and
	# get_tree() returns null. Bail out instead of crashing on the lookup.
	if not is_inside_tree():
		return
	_connect_vignette()

func _exit_tree() -> void:
	if GameManager.ui_ref == self:
		GameManager.ui_ref = null

func _build_hud() -> void:
	vignette = _make_overlay(Color(0, 0, 0, 0))
	vignette.mouse_filter = Control.MOUSE_FILTER_IGNORE
	var vig_mat = ShaderMaterial.new()
	vig_mat.shader = load("res://shaders/sanity_vignette.gdshader")
	vignette.material = vig_mat

	halluc_overlay = _make_overlay(Color(0.15, 0.0, 0.30, 0.65))
	halluc_overlay.visible = false
	halluc_overlay.mouse_filter = Control.MOUSE_FILTER_IGNORE

	static_overlay = _make_overlay(Color(1, 1, 1, 1))
	static_overlay.visible = false
	static_overlay.mouse_filter = Control.MOUSE_FILTER_IGNORE
	var static_mat = ShaderMaterial.new()
	static_mat.shader = load("res://shaders/static_overlay.gdshader")
	static_overlay.material = static_mat

	flash_overlay = _make_overlay(Color(1, 1, 1, 0))
	flash_overlay.visible = false
	flash_overlay.mouse_filter = Control.MOUSE_FILTER_IGNORE

	var hud_root = Control.new()
	hud_root.set_anchors_preset(Control.PRESET_FULL_RECT)
	hud_root.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(hud_root)

	var bars = VBoxContainer.new()
	bars.position = Vector2(14, 14)
	bars.custom_minimum_size = Vector2(156, 0)
	bars.add_theme_constant_override("separation", 7)
	hud_root.add_child(bars)

	var sanity_row = HBoxContainer.new()
	sanity_row.add_theme_constant_override("separation", 6)
	bars.add_child(sanity_row)

	var sanity_icon = Label.new()
	sanity_icon.text = "精"
	sanity_icon.add_theme_font_size_override("font_size", 10)
	sanity_icon.add_theme_color_override("font_color", Color(0.55, 0.60, 0.88))
	sanity_icon.custom_minimum_size = Vector2(14, 0)
	sanity_row.add_child(sanity_icon)

	sanity_bar = ProgressBar.new()
	sanity_bar.custom_minimum_size = Vector2(130, 7)
	sanity_bar.max_value = 100.0; sanity_bar.value = 100.0
	sanity_bar.show_percentage = false
	sanity_bar.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	_style_bar(sanity_bar, Color(0.42, 0.48, 0.82), Color(0.08, 0.07, 0.12))
	sanity_row.add_child(sanity_bar)

	var bat_row = HBoxContainer.new()
	bat_row.add_theme_constant_override("separation", 6)
	bars.add_child(bat_row)

	battery_icon = Label.new()
	battery_icon.text = "◉"
	battery_icon.add_theme_font_size_override("font_size", 10)
	battery_icon.add_theme_color_override("font_color", Color(0.75, 0.68, 0.28))
	battery_icon.custom_minimum_size = Vector2(14, 0)
	bat_row.add_child(battery_icon)

	battery_bar = ProgressBar.new()
	battery_bar.custom_minimum_size = Vector2(130, 7)
	battery_bar.max_value = 100.0; battery_bar.value = 100.0
	battery_bar.show_percentage = false
	battery_bar.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	_style_bar(battery_bar, Color(0.78, 0.68, 0.22), Color(0.08, 0.07, 0.12))
	bat_row.add_child(battery_bar)

	_build_hints(bars)

	note_counter = Label.new()
	note_counter.set_anchors_preset(Control.PRESET_TOP_RIGHT)
	note_counter.offset_left = -130; note_counter.offset_top = 14
	note_counter.offset_right = -14; note_counter.offset_bottom = 34
	note_counter.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
	note_counter.add_theme_font_size_override("font_size", 13)
	note_counter.add_theme_color_override("font_color", Color(0.52, 0.46, 0.38))
	hud_root.add_child(note_counter)

	var cross = Label.new()
	cross.set_anchors_preset(Control.PRESET_CENTER)
	cross.offset_left = -4; cross.offset_top = -4
	cross.offset_right = 4; cross.offset_bottom = 4
	cross.text = "·"
	cross.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	cross.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	cross.add_theme_color_override("font_color", Color(0.85, 0.80, 0.65, 0.45))
	cross.add_theme_font_size_override("font_size", 12)
	hud_root.add_child(cross)

	note_notif = PanelContainer.new()
	note_notif.set_anchors_preset(Control.PRESET_BOTTOM_LEFT)
	note_notif.offset_left = 14; note_notif.offset_top = -80
	note_notif.offset_right = 310; note_notif.offset_bottom = -14
	note_notif.visible = false
	hud_root.add_child(note_notif)

	var nv = VBoxContainer.new()
	nv.add_theme_constant_override("separation", 2)
	note_notif.add_child(nv)

	var pickup_lbl = Label.new()
	pickup_lbl.text = "形見を拾った"
	pickup_lbl.add_theme_font_size_override("font_size", 10)
	pickup_lbl.add_theme_color_override("font_color", Color(0.72, 0.54, 0.23))
	nv.add_child(pickup_lbl)

	note_notif_lbl = Label.new()
	note_notif_lbl.text = "—"
	note_notif_lbl.add_theme_font_size_override("font_size", 14)
	note_notif_lbl.add_theme_color_override("font_color", Color(0.88, 0.82, 0.70))
	nv.add_child(note_notif_lbl)

	note_reader = PanelContainer.new()
	note_reader.set_anchors_preset(Control.PRESET_CENTER)
	note_reader.offset_left = -260; note_reader.offset_top = -200
	note_reader.offset_right = 260; note_reader.offset_bottom = 200
	note_reader.visible = false
	hud_root.add_child(note_reader)

	var rv = VBoxContainer.new()
	rv.add_theme_constant_override("separation", 14)
	note_reader.add_child(rv)

	note_title_lbl = Label.new()
	note_title_lbl.text = "—"
	note_title_lbl.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	note_title_lbl.add_theme_font_size_override("font_size", 18)
	note_title_lbl.add_theme_color_override("font_color", Color(0.72, 0.54, 0.23))
	rv.add_child(note_title_lbl)

	rv.add_child(HSeparator.new())

	note_body_lbl = RichTextLabel.new()
	note_body_lbl.custom_minimum_size = Vector2(480, 130)
	note_body_lbl.bbcode_enabled = true
	note_body_lbl.scroll_active = false
	note_body_lbl.fit_content = true
	note_body_lbl.add_theme_font_size_override("normal_font_size", 14)
	note_body_lbl.add_theme_color_override("default_color", Color(0.85, 0.80, 0.70))
	rv.add_child(note_body_lbl)

	var close_hint = Label.new()
	close_hint.text = "[E] 閉じる — Close"
	close_hint.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	close_hint.add_theme_font_size_override("font_size", 10)
	close_hint.add_theme_color_override("font_color", Color(0.52, 0.46, 0.38))
	rv.add_child(close_hint)

	# Monologue subtitle — character self-talk when picking up notes
	monologue_lbl = Label.new()
	monologue_lbl.set_anchors_preset(Control.PRESET_BOTTOM_WIDE)
	monologue_lbl.offset_top = -110
	monologue_lbl.offset_bottom = -24
	monologue_lbl.offset_left = 60
	monologue_lbl.offset_right = -60
	monologue_lbl.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	monologue_lbl.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	monologue_lbl.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	monologue_lbl.add_theme_font_size_override("font_size", 16)
	monologue_lbl.add_theme_color_override("font_color", Color(0.90, 0.86, 0.75))
	monologue_lbl.modulate.a = 0.0
	monologue_lbl.mouse_filter = Control.MOUSE_FILTER_IGNORE
	hud_root.add_child(monologue_lbl)

	_build_cinematic_overlays(hud_root)

func _build_cinematic_overlays(parent: Control) -> void:
	_cinematic_panel = PanelContainer.new()
	_cinematic_panel.set_anchors_preset(Control.PRESET_FULL_RECT)
	_cinematic_panel.visible = false
	_cinematic_panel.mouse_filter = Control.MOUSE_FILTER_IGNORE
	parent.add_child(_cinematic_panel)

	var cv = CenterContainer.new()
	cv.set_anchors_preset(Control.PRESET_FULL_RECT)
	_cinematic_panel.add_child(cv)

	_cinematic_lbl = RichTextLabel.new()
	_cinematic_lbl.custom_minimum_size = Vector2(680, 220)
	_cinematic_lbl.bbcode_enabled = true
	_cinematic_lbl.fit_content = true
	_cinematic_lbl.scroll_active = false
	_cinematic_lbl.add_theme_font_size_override("normal_font_size", 17)
	_cinematic_lbl.add_theme_color_override("default_color", Color(0.88, 0.84, 0.76))
	cv.add_child(_cinematic_lbl)

	_area_card = PanelContainer.new()
	_area_card.set_anchors_preset(Control.PRESET_CENTER_TOP)
	_area_card.offset_top = 72
	_area_card.offset_left = -200
	_area_card.offset_right = 200
	_area_card.offset_bottom = 160
	_area_card.visible = false
	_area_card.mouse_filter = Control.MOUSE_FILTER_IGNORE
	parent.add_child(_area_card)

	var av = VBoxContainer.new()
	av.add_theme_constant_override("separation", 4)
	_area_card.add_child(av)

	_area_jp = Label.new()
	_area_jp.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_area_jp.add_theme_font_size_override("font_size", 28)
	_area_jp.add_theme_color_override("font_color", Color(0.78, 0.58, 0.22))
	av.add_child(_area_jp)

	_area_en = Label.new()
	_area_en.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_area_en.add_theme_font_size_override("font_size", 14)
	_area_en.add_theme_color_override("font_color", Color(0.72, 0.66, 0.56))
	av.add_child(_area_en)

	_area_sub = Label.new()
	_area_sub.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_area_sub.add_theme_font_size_override("font_size", 11)
	_area_sub.add_theme_color_override("font_color", Color(0.52, 0.48, 0.42))
	av.add_child(_area_sub)

	_subtitle_lbl = Label.new()
	_subtitle_lbl.set_anchors_preset(Control.PRESET_BOTTOM_WIDE)
	_subtitle_lbl.offset_top = -72
	_subtitle_lbl.offset_bottom = -28
	_subtitle_lbl.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_subtitle_lbl.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_subtitle_lbl.add_theme_font_size_override("font_size", 15)
	_subtitle_lbl.add_theme_color_override("font_color", Color(0.92, 0.88, 0.78))
	_subtitle_lbl.modulate.a = 0.0
	_subtitle_lbl.mouse_filter = Control.MOUSE_FILTER_IGNORE
	parent.add_child(_subtitle_lbl)

func show_cinematic_text(lines: Array, hold_sec: float = 4.0) -> void:
	if not _cinematic_panel:
		return
	var body := ""
	for line in lines:
		if str(line).is_empty():
			body += "\n"
		else:
			body += "[center]%s[/center]\n" % str(line)
	_cinematic_lbl.bbcode_text = body
	_cinematic_panel.modulate.a = 0.0
	_cinematic_panel.visible = true
	GameManager.state = GameManager.GameState.CINEMATIC
	var tw = create_tween()
	tw.tween_property(_cinematic_panel, "modulate:a", 1.0, 1.1)
	await tw.finished
	await get_tree().create_timer(hold_sec).timeout
	var tw2 = create_tween()
	tw2.tween_property(_cinematic_panel, "modulate:a", 0.0, 1.0)
	await tw2.finished
	_cinematic_panel.visible = false
	if GameManager.state == GameManager.GameState.CINEMATIC:
		GameManager.state = GameManager.GameState.PLAYING

func show_area_card(data: Dictionary) -> void:
	if not _area_card:
		return
	_area_jp.text = data.get("jp", "")
	_area_en.text = data.get("en", "")
	_area_sub.text = data.get("sub", "")
	_area_card.modulate.a = 0.0
	_area_card.visible = true
	var tw = create_tween()
	tw.tween_property(_area_card, "modulate:a", 1.0, 0.9)
	await get_tree().create_timer(3.2).timeout
	tw = create_tween()
	tw.tween_property(_area_card, "modulate:a", 0.0, 0.8)
	await tw.finished
	_area_card.visible = false
	_area_card.modulate.a = 1.0

func show_subtitle(text: String, duration: float = 3.5) -> void:
	if not _subtitle_lbl:
		return
	_subtitle_lbl.text = text
	var tw = create_tween()
	tw.tween_property(_subtitle_lbl, "modulate:a", 1.0, 0.5)
	await get_tree().create_timer(duration).timeout
	tw = create_tween()
	tw.tween_property(_subtitle_lbl, "modulate:a", 0.0, 0.7)

func _build_hints(parent: Control) -> void:
	var sep = Control.new()
	sep.custom_minimum_size = Vector2(0, 10)
	parent.add_child(sep)

	const HINTS = [
		["WASD", "移動 / Move"],
		["F",    "懐中電灯 / Flashlight"],
		["E",    "調べる / Examine"],
		["Esc",  "一時停止 / Pause"],
	]

	var container = VBoxContainer.new()
	container.add_theme_constant_override("separation", 4)
	container.modulate.a = 0.0
	parent.add_child(container)

	for pair in HINTS:
		var row = HBoxContainer.new()
		row.add_theme_constant_override("separation", 6)
		container.add_child(row)

		var key_lbl = Label.new()
		key_lbl.text = "[%s]" % pair[0]
		key_lbl.custom_minimum_size = Vector2(38, 0)
		key_lbl.add_theme_font_size_override("font_size", 9)
		key_lbl.add_theme_color_override("font_color", Color(0.72, 0.68, 0.48))
		row.add_child(key_lbl)

		var act_lbl = Label.new()
		act_lbl.text = pair[1]
		act_lbl.add_theme_font_size_override("font_size", 9)
		act_lbl.add_theme_color_override("font_color", Color(0.52, 0.50, 0.40))
		row.add_child(act_lbl)

	# Fade in after 0.5 s, hold 16 s, then fade out
	await get_tree().create_timer(0.5).timeout
	var tw_in = create_tween()
	tw_in.tween_property(container, "modulate:a", 0.85, 0.8)
	await get_tree().create_timer(16.0).timeout
	var tw_out = create_tween()
	tw_out.tween_property(container, "modulate:a", 0.0, 2.0)

func _build_pause_menu() -> void:
	pause_menu = Control.new()
	pause_menu.set_anchors_preset(Control.PRESET_FULL_RECT)
	pause_menu.visible = false
	add_child(pause_menu)

	var bg = ColorRect.new()
	bg.set_anchors_preset(Control.PRESET_FULL_RECT)
	bg.color = Color(0.02, 0.015, 0.01, 0.88)
	bg.mouse_filter = Control.MOUSE_FILTER_STOP
	pause_menu.add_child(bg)

	var center = CenterContainer.new()
	center.set_anchors_preset(Control.PRESET_FULL_RECT)
	pause_menu.add_child(center)

	var vbox = VBoxContainer.new()
	vbox.custom_minimum_size = Vector2(240, 0)
	vbox.add_theme_constant_override("separation", 12)
	center.add_child(vbox)

	var title = Label.new()
	title.text = "一時停止"
	title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	title.add_theme_font_size_override("font_size", 24)
	title.add_theme_color_override("font_color", Color(0.72, 0.54, 0.23))
	vbox.add_child(title)

	var spacer = Control.new()
	spacer.custom_minimum_size = Vector2(0, 8)
	vbox.add_child(spacer)

	var resume_btn = _make_pause_btn("再開 / Resume")
	resume_btn.pressed.connect(GameManager.resume_game)
	vbox.add_child(resume_btn)

	var settings_sub = VBoxContainer.new()
	settings_sub.visible = false
	settings_sub.add_theme_constant_override("separation", 8)

	var settings_btn = _make_pause_btn("設定 / Settings")
	settings_btn.pressed.connect(func(): settings_sub.visible = !settings_sub.visible)
	vbox.add_child(settings_btn)

	vbox.add_child(settings_sub)

	var menu_btn = _make_pause_btn("メインメニュー / Main Menu")
	menu_btn.pressed.connect(_on_main_menu)
	vbox.add_child(menu_btn)

	var perf_lbl = Label.new()
	perf_lbl.text = "Performance Mode"
	perf_lbl.add_theme_font_size_override("font_size", 11)
	perf_lbl.add_theme_color_override("font_color", Color(0.60, 0.55, 0.45))
	settings_sub.add_child(perf_lbl)

	var perf_toggle = CheckButton.new()
	perf_toggle.text = "有効 / Enable"
	perf_toggle.button_pressed = GameManager.performance_mode
	perf_toggle.toggled.connect(GameManager.set_performance_mode)
	settings_sub.add_child(perf_toggle)

	_add_graphics_settings(settings_sub)

	var vol_lbl = Label.new()
	vol_lbl.text = "マスター音量 / Volume"
	vol_lbl.add_theme_font_size_override("font_size", 11)
	vol_lbl.add_theme_color_override("font_color", Color(0.60, 0.55, 0.45))
	settings_sub.add_child(vol_lbl)

	var slider = HSlider.new()
	slider.min_value = 0.0; slider.max_value = 40.0; slider.value = 20.0
	slider.value_changed.connect(func(v): AudioServer.set_bus_volume_db(AudioServer.get_bus_index("Master"), v - 20.0))
	settings_sub.add_child(slider)

func _style_bar(bar: ProgressBar, fill_col: Color, bg_col: Color) -> void:
	var fill = StyleBoxFlat.new()
	fill.bg_color = fill_col
	fill.set_corner_radius_all(2)
	bar.add_theme_stylebox_override("fill", fill)
	var bg = StyleBoxFlat.new()
	bg.bg_color = bg_col
	bg.set_corner_radius_all(2)
	bg.set_border_width_all(1)
	bg.border_color = Color(0.22, 0.20, 0.16, 0.6)
	bar.add_theme_stylebox_override("background", bg)

func _add_graphics_settings(parent: Control) -> void:
	var g_lbl = Label.new()
	g_lbl.text = "画質 / Graphics"
	g_lbl.add_theme_font_size_override("font_size", 11)
	g_lbl.add_theme_color_override("font_color", Color(0.60, 0.55, 0.45))
	parent.add_child(g_lbl)

	var opt = OptionButton.new()
	opt.add_item("低 / Low", GameManager.GraphicsQuality.LOW)
	opt.add_item("中 / Medium", GameManager.GraphicsQuality.MEDIUM)
	opt.add_item("高 / High", GameManager.GraphicsQuality.HIGH)
	opt.selected = GameManager.graphics_quality
	opt.item_selected.connect(func(idx): GameManager.set_graphics_quality(idx))
	parent.add_child(opt)

	var sens_lbl = Label.new()
	sens_lbl.text = "マウス感度 / Mouse"
	sens_lbl.add_theme_font_size_override("font_size", 11)
	sens_lbl.add_theme_color_override("font_color", Color(0.60, 0.55, 0.45))
	parent.add_child(sens_lbl)

	var sens = HSlider.new()
	sens.min_value = 0.001
	sens.max_value = 0.006
	sens.step = 0.0002
	sens.value = GameManager.mouse_sensitivity
	sens.value_changed.connect(func(v):
		GameManager.mouse_sensitivity = v
		GameManager.save_setting("mouse_sensitivity", v))
	parent.add_child(sens)

func _make_overlay(col: Color) -> ColorRect:
	var r = ColorRect.new()
	r.set_anchors_preset(Control.PRESET_FULL_RECT)
	r.color = col
	add_child(r)
	return r

func _make_pause_btn(txt: String) -> Button:
	var b = Button.new()
	b.text = txt
	b.custom_minimum_size = Vector2(220, 42)
	b.add_theme_font_size_override("font_size", 15)
	return b

func _connect_vignette() -> void:
	var player = get_tree().get_first_node_in_group("player")
	if player:
		var sanity = player.get_node_or_null("SanitySystem")
		if sanity and vignette.material is ShaderMaterial:
			sanity.vignette_mat = vignette.material as ShaderMaterial
			sanity.overlay_node = halluc_overlay

func _process(_delta: float) -> void:
	# _build_hud constructs the bars synchronously in _ready, but _process can
	# fire during early teardown of the HUD on scene swap when child Controls
	# have already been freed but UIManager itself hasn't been. Guard the bars.
	if sanity_bar and is_instance_valid(GameManager.sanity_ref):
		sanity_bar.value = GameManager.sanity_ref.sanity
	var fl = _get_flashlight()
	if battery_bar and fl:
		battery_bar.value = fl.battery
		if battery_icon:
			battery_icon.modulate = Color(0.78, 0.74, 0.52)

func _refresh_note_counter() -> void:
	var n = GameManager.collected_notes.size()
	note_counter.text = "形見  %d / %d" % [n, GameManager.notes_total]
	var t = float(n) / float(GameManager.notes_total)
	note_counter.add_theme_color_override("font_color",
		Color(lerpf(0.52, 0.78, t), lerpf(0.46, 0.58, t), lerpf(0.38, 0.25, t)))

func _on_note_collected(id: int) -> void:
	_refresh_note_counter()
	AudioManager.play_sfx("player_voice_" + str(id))
	var text = MONOLOGUE.get(id, "")
	if not text.is_empty():
		show_monologue(text)

func show_monologue(text: String) -> void:
	if not monologue_lbl:
		return
	monologue_lbl.text = "\" " + text + " \""
	var tw_in = create_tween()
	tw_in.tween_property(monologue_lbl, "modulate:a", 1.0, 0.6)
	await get_tree().create_timer(5.5).timeout
	var tw_out = create_tween()
	tw_out.tween_property(monologue_lbl, "modulate:a", 0.0, 1.2)

func show_note_notification(note_id: int) -> void:
	note_notif_lbl.text = NOTE_JP.get(note_id, "形見")
	note_notif.modulate.a = 0.0
	note_notif.visible = true
	var tw = create_tween()
	tw.tween_property(note_notif, "modulate:a", 1.0, 0.3)
	await get_tree().create_timer(3.0).timeout
	tw = create_tween()
	tw.tween_property(note_notif, "modulate:a", 0.0, 0.5)
	await tw.finished
	note_notif.visible = false
	note_notif.modulate.a = 1.0

func show_note(data: Dictionary) -> void:
	var title_jp = data.get("title_jp", "")
	var title_en = data.get("title_en", "")
	note_title_lbl.text = "%s  ·  %s" % [title_jp, title_en]
	var body = "[center][i]%s[/i][/center]\n\n[center][color=#a09888]%s[/color][/center]" % [
		data.get("text_jp", "").replace("\n", "\n"),
		data.get("text_en", "")]
	note_body_lbl.bbcode_text = body
	note_reader.modulate.a = 0.0
	note_reader.visible = true
	GameManager.state = GameManager.GameState.CINEMATIC
	var tw = create_tween()
	tw.tween_property(note_reader, "modulate:a", 1.0, 0.35)
	await tw.finished
	var t = 0.0
	while t < 9.0:
		t += get_process_delta_time()
		if Input.is_action_just_pressed("interact"):
			break
		await get_tree().process_frame
	tw = create_tween()
	tw.tween_property(note_reader, "modulate:a", 0.0, 0.4)
	await tw.finished
	note_reader.visible = false
	note_reader.modulate.a = 1.0
	GameManager.state = GameManager.GameState.PLAYING

func show_pause_menu() -> void:
	pause_menu.visible = true

func hide_pause_menu() -> void:
	pause_menu.visible = false

func _on_jumpscare_fired(intensity: int) -> void:
	_do_flash(intensity)
	_do_static(intensity)

func _do_flash(intensity: int) -> void:
	const ALPHAS = [0.35, 0.60, 0.82, 0.96]
	const COLORS = [Color(1,1,1), Color(1,0.95,0.88), Color(1,0.90,0.82), Color(1,0.88,0.80)]
	const DURS   = [0.18, 0.30, 0.48, 0.65]
	flash_overlay.color = COLORS[intensity]
	flash_overlay.modulate.a = ALPHAS[intensity]
	flash_overlay.visible = true
	var tw = create_tween()
	tw.tween_property(flash_overlay, "modulate:a", 0.0, DURS[intensity])
	await tw.finished
	flash_overlay.visible = false
	flash_overlay.modulate.a = 1.0

func _do_static(intensity: int) -> void:
	if intensity < 1:
		return
	const DURS = [0.0, 0.05, 0.10, 0.18]
	static_overlay.visible = true
	await get_tree().create_timer(DURS[intensity]).timeout
	static_overlay.visible = false

func _on_main_menu() -> void:
	get_tree().paused = false
	GameManager.state = GameManager.GameState.MENU
	Input.set_mouse_mode(Input.MOUSE_MODE_VISIBLE)
	get_tree().change_scene_to_file("res://scenes/main/MainMenu.tscn")

func _get_flashlight() -> Node:
	var player = get_tree().get_first_node_in_group("player")
	return player.get_node_or_null("Camera3D/HandPivot/Flashlight") if player else null
