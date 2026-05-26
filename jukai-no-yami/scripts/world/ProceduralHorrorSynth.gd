extends AudioStreamPlayer
## ProceduralHorrorSynth — generates a sub-bass horror drone at runtime
## using an AudioStreamGenerator buffer. No external audio files required.
##
## Setup:
##   1. Add an AudioStreamPlayer to your scene.
##   2. Attach THIS script to it.
##   3. (Optional) Adjust the @export tunables in the Inspector.
##   4. Press play — the synth auto-starts via _ready().
##
## Architecture: AudioStreamGenerator is assigned as the player's stream,
## then on every _process() frame we ask the playback object how many
## frames the engine can consume and write that many in one PackedVector2
## buffer push. push_buffer() is one engine call regardless of frame count,
## which is dramatically cheaper than push_frame() in a per-sample loop.

# Mix rate. 22050 Hz is half the standard sample rate but more than
# enough for sub-bass content (Nyquist = 11 kHz, way above our drone).
@export var mix_rate: float = 22050.0
# Generator buffer length — bigger = safer against frame-rate dips,
# smaller = lower audio latency. 0.4 s is a good middle ground.
@export_range(0.05, 1.0, 0.05) var buffer_seconds: float = 0.40

# Drone fundamental (Hz). 45 Hz sits below E1, deep sub-bass territory.
@export_range(30.0, 100.0, 1.0) var fundamental_hz: float = 45.0
# Slow LFO that modulates the drone — adds a "breathing" quality.
@export_range(0.05, 1.0, 0.05) var lfo_hz: float = 0.18
# Output level. -10 dB ≈ 0.316 amplitude — loud enough to feel but never
# clipping. We keep this conservative because additive overdrive on a
# sub-bass signal sounds like a blown speaker.
@export_range(-40.0, 0.0, 0.5) var output_db: float = -10.0

# Wind / tape hiss level (linear 0..1).
@export_range(0.0, 0.5, 0.01) var hiss_amount: float = 0.06

# If true, the synth auto-plays on _ready(). Set false to drive it
# manually via start() / stop().
@export var autostart: bool = true


# ── Internal state ──────────────────────────────────────────────────────
var _gen: AudioStreamGenerator
var _pb: AudioStreamGeneratorPlayback = null
var _time: float = 0.0
# 1-pole low-pass state for the tape-hiss noise — running average that
# kills the brittle high frequencies, leaving a warm "wind" sound.
var _hiss_lp_l: float = 0.0
var _hiss_lp_r: float = 0.0
var _rng := RandomNumberGenerator.new()


func _ready() -> void:
	_rng.randomize()
	# Build the generator and assign it to ourselves (an AudioStreamPlayer).
	_gen = AudioStreamGenerator.new()
	_gen.mix_rate = mix_rate
	_gen.buffer_length = buffer_seconds
	stream = _gen
	# Convert output_db to linear and apply to the player.
	volume_db = output_db
	if autostart:
		start_synth()


# Public — start the synth. Idempotent.
func start_synth() -> void:
	if not playing:
		play()
	_pb = get_stream_playback() as AudioStreamGeneratorPlayback


# Public — stop the synth cleanly.
func stop_synth() -> void:
	if playing:
		stop()
	_pb = null


func _process(_delta: float) -> void:
	if _pb == null:
		_pb = get_stream_playback() as AudioStreamGeneratorPlayback
		if _pb == null:
			return
	# How many stereo frames the engine wants for this update cycle.
	var available: int = _pb.get_frames_available()
	if available <= 0:
		return
	_fill_buffer(available)


# Build `count` stereo frames and push them in ONE batch call. Doing all
# the math here in a tight loop, then submitting to the engine in a
# single push_buffer() call, is the cheap-and-safe pattern.
func _fill_buffer(count: int) -> void:
	var buf := PackedVector2Array()
	buf.resize(count)
	var inv_rate := 1.0 / mix_rate
	# Pre-cache common constants outside the hot loop.
	var two_pi_f0 := TAU * fundamental_hz
	var two_pi_f0_15 := TAU * fundamental_hz * 1.5     # de-tuned harmonic
	var two_pi_f0_2 := TAU * fundamental_hz * 2.01     # slightly-out octave
	var two_pi_lfo := TAU * lfo_hz
	for i in count:
		var t: float = _time + float(i) * inv_rate
		# Slow LFO — pushes amplitude up and down breathing-style
		var lfo: float = 0.5 + 0.5 * sin(two_pi_lfo * t)
		# Sub-bass drone: three closely-tuned sines, slightly de-tuned
		# from a perfect harmonic ratio to create beating tension.
		var drone: float  = sin(two_pi_f0    * t) * 0.55
		drone           += sin(two_pi_f0_15 * t) * 0.32
		drone           += sin(two_pi_f0_2  * t) * 0.18
		# Sub-bass modulation envelope — the drone breathes with the LFO.
		drone *= 0.55 + 0.45 * lfo
		# Tape-hiss noise — pseudo-random white, then 1-pole LP filter
		# (running average) to roll off the brittle highs. Different
		# noise samples per channel give a wide stereo image.
		var n_l: float = _rng.randf() * 2.0 - 1.0
		var n_r: float = _rng.randf() * 2.0 - 1.0
		# alpha = 0.12 → cutoff ≈ 420 Hz at 22 kHz sample rate
		_hiss_lp_l = _hiss_lp_l * 0.88 + n_l * 0.12
		_hiss_lp_r = _hiss_lp_r * 0.88 + n_r * 0.12
		var hiss_l: float = _hiss_lp_l * hiss_amount
		var hiss_r: float = _hiss_lp_r * hiss_amount
		# Compose final stereo frame — drone dead-centred so the bass
		# stays mono-compatible (sub-bass off-centre sounds wrong on
		# small speakers), hiss panned mildly differently per channel
		# for ambience width.
		var left: float  = drone + hiss_l
		var right: float = drone + hiss_r
		# Soft saturation — keeps loud peaks from clipping when the
		# drone + hiss happen to constructively interfere.
		left  = tanh(left)
		right = tanh(right)
		buf[i] = Vector2(left, right)
	# Single engine call for all frames — the cheap pattern.
	_pb.push_buffer(buf)
	_time += float(count) * inv_rate
