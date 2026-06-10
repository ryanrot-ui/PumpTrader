extends Node
## Story beats for 樹海の闇 — Aokigahara suicide forest horror.
## Chillas Art style: short text cards, no cutscenes required.

const AREA_CARDS: Dictionary = {
	"res://scenes/levels/ParkingLot.tscn": {
		"jp": "駐車場",
		"en": "Parking Lot — Before the Sea of Trees",
		"sub": "青木ヶ原の入り口 · Aokigahara's threshold",
	},
	"res://scenes/levels/ForestEntrance.tscn": {
		"jp": "森の入り口",
		"en": "Forest Entrance",
		"sub": "白いリボンが風に揺れる · Ribbons mark the dead",
	},
	"res://scenes/levels/DenseTreeSea.tscn": {
		"jp": "樹海の奥",
		"en": "Deep in the Jukai",
		"sub": "道はもう見えない · The path disappears",
	},
	"res://scenes/levels/RibbonPathCave.tscn": {
		"jp": "リボンの小道",
		"en": "Ribbon Path — Toward the Exit",
		"sub": "出口は近い · Or so you pray",
	},
}

const OPENING_LINES: Array[String] = [
	"青木ヶ原樹海",
	"Aokigahara — the Sea of Trees",
	"",
	"One year ago, my sister Hanako walked into this forest.",
	"The police found her car. Nothing else. Case closed.",
	"",
	"Last week a parcel arrived. No sender.",
	"Inside: her house key, and a photograph of a torii gate.",
	"",
	"Tonight, I follow her in.",
]

const PARKING_LOT_LINES: Array[String] = [
	"The lot is empty. My engine ticks as it cools.",
	"Her car was found here. This exact row.",
	"She left four things behind in there. I'm not leaving without them.",
]

func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS

func on_level_loaded(path: String) -> void:
	if not GameManager.ui_ref:
		await _wait_for_hud()
	var card = AREA_CARDS.get(path, {})
	if card.is_empty():
		return
	await get_tree().create_timer(0.6).timeout
	if GameManager.ui_ref.has_method("show_area_card"):
		await GameManager.ui_ref.show_area_card(card)

func play_game_opening() -> void:
	if GameManager.intro_played:
		return
	GameManager.intro_played = true
	if not GameManager.ui_ref:
		await _wait_for_hud()
	if GameManager.ui_ref.has_method("show_cinematic_text"):
		await GameManager.ui_ref.show_cinematic_text(OPENING_LINES, 4.8)
	await get_tree().create_timer(0.4).timeout
	if GameManager.ui_ref.has_method("show_cinematic_text"):
		await GameManager.ui_ref.show_cinematic_text(PARKING_LOT_LINES, 3.2)

func play_exit_approach() -> void:
	if not GameManager.ui_ref:
		return
	# If the player has read note 3, they know the light may not be theirs —
	# the line changes to reflect that dread.
	if GameManager.ui_ref.has_method("show_subtitle"):
		if 3 in GameManager.collected_notes:
			GameManager.ui_ref.show_subtitle(
				"あの光…「あなたのものではない」/ That light... 'It was never meant for you.'", 4.5)
		else:
			GameManager.ui_ref.show_subtitle(
				"出口の光が見える… / I see light. Is that the way out?", 4.0)

func _wait_for_hud() -> void:
	for _i in 30:
		if GameManager.ui_ref:
			return
		await get_tree().process_frame
