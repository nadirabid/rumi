"""Mechanism recipes: gears, rack and pinion, ratchet, crank-slider, cam, detent slider and flexure spring.

Kit names (cylinder, cut, join, frame, place, joint, ...) are injected by rumi_joints. Every rotating part sits on an
integral post with a solid head wider than its bore (the `captive_axle` recipe), so nothing is loose hardware.
"""


def _captive_axle():
    """Load `captive_axle` from the sibling axles recipe file (recipe files do not see each other's names)."""
    return runpy.run_path(str(_HERE / 'joints' / 'axles.py'), init_globals=dict(globals()))['captive_axle']


# ---------------------------------------------------------------- gears

_PRESSURE = math.radians(20)


def _inv(angle):
    return math.tan(angle) - angle


def _gear_outline(teeth, module, backlash, tip_trim, phase=0.0):
    """Closed counter-clockwise involute outline with tooth 0 centred on +u. Each tooth is `backlash / 2` thinner at the pitch circle."""
    pitch_r = module * teeth / 2
    base_r = pitch_r * math.cos(_PRESSURE)
    root_r = pitch_r - 1.25 * module
    tip_r = pitch_r + module - tip_trim
    half = (math.pi * module / 2 - backlash / 2) / (2 * pitch_r)

    def angle(radius):
        return half + _inv(_PRESSURE) - _inv(math.acos(min(1.0, base_r / radius)))

    if angle(tip_r) * tip_r * 2 < 0.4:
        raise ValueError('spur_gear: teeth are pointed (tip under 0.4 mm wide); use more teeth, a larger module or a smaller backlash')
    start = max(base_r, root_r)
    radii = [start + (tip_r - start) * i / 9 for i in range(10)]
    points = []
    for k in range(teeth):
        centre = phase + 2 * math.pi * k / teeth
        right, left = [], []
        if base_r > root_r:                       # radial run from the root to the base circle
            right.append((root_r, centre - angle(base_r)))
            left.append((root_r, centre + angle(base_r)))
        for r in radii:
            right.append((r, centre - angle(r)))
            left.append((r, centre + angle(r)))
        tip = [(tip_r, centre - angle(tip_r) + 2 * angle(tip_r) * j / 4) for j in range(1, 4)]
        for r, a in right + tip + left[::-1]:
            points.append((r * math.cos(a), r * math.sin(a)))
        a0 = centre + angle(max(base_r, root_r))
        a1 = centre + 2 * math.pi / teeth - angle(max(base_r, root_r))
        for j in range(1, 4):
            a = a0 + (a1 - a0) * j / 4
            points.append((root_r * math.cos(a), root_r * math.sin(a)))
    return points


def spur_gear(name, teeth, pivot, axis, module=2, width=6, xdir=None, phase_degrees=0, backlash=0.8, tip_trim=0, end_play=0.3, standoff=1.0):
    """Make an involute spur gear blank (20 degree pressure angle) ready for `captive_axle`, like `wheel` is for wheels.

    pivot: where its post starts on the mounting face; axis: direction pointing away from the body. The inner face sits
    standoff + end_play mm off the mounting face. Tooth 0 points along `xdir` (default: the frame default) turned by
    `phase_degrees`. backlash is the total circumferential play of a meshing pair in mm (each gear gives half). The
    gap between meshing flanks is about 0.47 x backlash, so keep it at 0.7 or more for the checker's 0.3 mm.
    tip_trim shortens the teeth (gear_pair sets it).
    """
    if teeth < 12 or module < 1.5:
        raise ValueError('spur_gear: use at least 12 teeth and module 1.5 (module is the pitch diameter divided by the tooth count)')
    if backlash < 0.7:
        raise ValueError('spur_gear: backlash under 0.7 mm leaves a tooth gap under the checker\'s 0.3 mm')
    outline = _gear_outline(teeth, module, backlash, tip_trim, math.radians(phase_degrees))
    part = prism(name, outline, width, (0, 0, standoff + end_play + width / 2))
    return place(part, frame(pivot, axis, xdir))


def gear_pair(base, pivot, axis, teeth_a, teeth_b, toward=None, module=2, width=6, axle_diameter=6, backlash=0.8,
              limits=None, stagger=0.5, names=('GearA', 'GearB'), controls=(None, None)):
    """Two meshing spur gears, each on an integral captive post that grows out of `base`; returns their two revolute joints.

    pivot: centre of gear A on the base's mounting face. axis: direction away from the base. toward: direction from
    gear A to gear B (perpendicular to axis; default the frame default). Gear B is placed at the exact centre
    distance module * (teeth_a + teeth_b) / 2 and its tooth phase is set so the teeth interleave. Both gears are one
    print-in-place assembly with the base. Needs `width` >= 6 and a flat base face reaching 7 mm around both posts.
    Gear B sits `stagger` mm higher than gear A so the two faces are not coplanar (coplanar faces gave false contacts
    in the checker). limits applies to both joints; by default +-180 degrees when the tooth ratio is at most 1.45, otherwise
    +-10: the checker's driver cannot turn a gear much lighter than its partner far in its fixed time, and reports a
    false block, so a larger ratio is verified over a short range only.
    """
    if min(teeth_a, teeth_b) < 14:
        raise ValueError('gear_pair: use at least 14 teeth on each gear (12 and 13 tooth gears jammed or overlapped in the checker)')
    if limits is None:
        limits = (-180, 180) if max(teeth_a, teeth_b) <= 1.45 * min(teeth_a, teeth_b) else (-10, 10)
    spacing = module * (teeth_a + teeth_b) / 2
    world = frame(pivot, axis, toward)
    line = world.to_3x3() @ Vector((1, 0, 0))
    centre_b = tuple(Vector(pivot) + line * spacing)
    reach = spacing * math.sin(_PRESSURE)

    def trim(count):
        pitch_r = module * count / 2
        base_r = pitch_r * math.cos(_PRESSURE)
        return max(0.0, pitch_r + module - (math.sqrt(base_r ** 2 + reach ** 2) - 0.1))

    clip = module * 1.5 + axle_diameter / 2 + 0.3 + 1.2 + 0.3 + 1.0
    if module * min(teeth_a, teeth_b) / 2 - 1.25 * module < clip - 1.0:
        raise ValueError('gear_pair: the smaller gear is too small for the axle; use more teeth or a larger module')
    gear_a = spur_gear(names[0], teeth_a, pivot, axis, module, width, toward, 0, backlash, trim(teeth_a))
    gear_b = spur_gear(names[1], teeth_b, centre_b, axis, module, width, -line, 180 / teeth_b, backlash, trim(teeth_b), standoff=1.0 + stagger)
    axle = _captive_axle()
    joints = []
    for gear, point, label, standoff in ((gear_a, pivot, controls[0], 1.0), (gear_b, centre_b, controls[1], 1.0 + stagger)):
        joints.append(axle(base, gear, point, axis, width=width, axle_diameter=axle_diameter, standoff=standoff, limits=limits,
                           control=label, name=gear.name + 'Axle'))
    return joints


# ---------------------------------------------------------------- rack and pinion

def _stadium(length, width, segments=24):
    """Outline of a slot `length` long and `width` wide with round ends, centred on the origin."""
    radius, half = width / 2, length / 2 - width / 2
    right = [(half + radius * math.cos(math.pi * (i / segments - 0.5)), radius * math.sin(math.pi * (i / segments - 0.5))) for i in range(segments + 1)]
    return right + [(-x, -y) for x, y in right]


def _rack_outline(teeth, module, backlash, back, addendum, offset):
    """Rack outline in (x, y) with the pitch line at y = `offset`, 20 degree straight flanks and teeth pointing +y; `teeth` is odd so one tooth sits on x = 0."""
    pitch = math.pi * module
    tan = math.tan(_PRESSURE)
    half_tooth = (pitch / 2 - backlash / 2) / 2
    root = -1.25 * module
    top_half, root_half = half_tooth - addendum * tan, half_tooth - root * tan
    points = [(-teeth * pitch / 2, root - back), (teeth * pitch / 2, root - back), (teeth * pitch / 2, root)]
    for k in range(teeth - 1, -1, -1):
        centre = (k - (teeth - 1) / 2) * pitch
        points += [(centre + root_half, root), (centre + top_half, addendum), (centre - top_half, addendum), (centre - root_half, root)]
    points.append((-teeth * pitch / 2, root))
    return [(x, y + offset) for x, y in points]


def _headed_post(parent, world, point, stem, head, top, standoff, head_height):
    """Fuse a post with a shoulder washer and a solid chamfered head (underside at `top`) to `parent` at local `point` of the frame `world`."""
    post = cylinder('_post', stem, top + 3, (0, 0, (top - 1) / 2))
    join(post, cylinder('_shoulder', head + 2, standoff + 2, (0, 0, (standoff - 2) / 2)))
    join(post, lathe('_head', [(0, top), (head, top), (head, top + head_height - 0.6), (head - 0.6, top + head_height), (0, top + head_height)]))
    move(post, (point[0], point[1], 0))
    join(parent, place(post, world))


def rack_pinion(base, pivot, axis, slide, pinion_teeth=16, module=2, width=6, travel=30, backlash=0.8, back=10,
                post_diameter=4, pinion_axle=6, names=('Pinion', 'Rack'), controls=(None, None)):
    """A pinion turning on a captive post and a rack that slides past it, held on two integral posts with end stops; returns two joints.

    pivot: centre of the pinion on the base's mounting face. axis: direction away from the base. slide: direction the
    rack slides (perpendicular to axis). The rack lies on the -(axis x slide) side of the pinion with its teeth towards
    it. travel: total rack travel in mm; the saved pose is mid-travel, so the rack joint spans -travel/2 .. +travel/2 and
    the pinion joint the matching angle. The rack has a slot over two posts whose heads (wider than the slot) keep it
    down; the slot ends stop it 0.3 mm beyond the declared range. The base must reach about `travel` + 40 mm along `slide`
    and about 5 mm + back + 2.5 mm beyond the pitch line on the rack side.
    """
    pitch_r = module * pinion_teeth / 2
    pitch = math.pi * module
    addendum = min(module, pitch_r * math.sin(_PRESSURE) ** 2 - 0.15)
    if pinion_teeth < 12 or addendum < 0.8:
        raise ValueError('rack_pinion: use at least 12 pinion teeth')
    if travel / 2 / pitch_r * 180 / math.pi > 180:
        raise ValueError('rack_pinion: travel needs more than half a turn of the pinion; use a shorter travel or more teeth')
    clearance, overhang, head_height, standoff, end_play = 0.3, 1.2, 2.5, 0.0, 0.3
    bore = post_diameter / 2 + clearance
    head = bore + overhang
    if back < 2 * bore + 4:
        raise ValueError('rack_pinion: back must be at least %.1f mm for this post_diameter' % (2 * bore + 4))
    spacing = 2 * head + 0.6                       # post to post: the two heads sit side by side
    slot_length = spacing + 2 * bore + travel
    teeth = max(math.ceil(travel / pitch) + 3, math.ceil((slot_length + 6) / pitch))
    teeth += 1 - teeth % 2
    world = frame(pivot, axis, slide)
    seat = standoff + end_play
    zmid = seat + width / 2
    slot_y = -pitch_r - 1.25 * module - back / 2

    outline = _rack_outline(teeth, module, backlash, back, addendum, -pitch_r)
    rack = place(prism(names[1], outline, width, (0, 0, zmid)), world)
    slot = prism('_slot', _stadium(slot_length, 2 * bore), width + 4, (0, slot_y, zmid))
    cut(rack, place(slot, world))
    for x in (-spacing / 2, spacing / 2):
        _headed_post(base, world, (x, slot_y), post_diameter / 2, head, seat + width + end_play, standoff, head_height)
    require_one_solid(base, 'rack_pinion', 'Make the base reach the rack posts, about %.0f mm to the rack side of the pivot.' % (-slot_y))

    pinion = spur_gear(names[0], pinion_teeth, pivot, axis, module, width, slide, -90 - 180 / pinion_teeth, backlash, standoff=0.5)
    turn = travel / 2 / pitch_r * 180 / math.pi
    pinion_joint = _captive_axle()(base, pinion, pivot, axis, width=width, axle_diameter=pinion_axle, limits=(-turn, turn), standoff=0.5,
                                   control=controls[0], name=names[0] + 'Axle')
    centre = tuple(world @ Vector((0, slot_y, zmid)))
    rack_joint = joint(names[1] + 'Slide', 'prismatic', base, rack, slide, centre, (-travel / 2, travel / 2), controls[1])
    return [pinion_joint, rack_joint]


# ---------------------------------------------------------------- ratchet

def ratchet(base, pivot, axis, up, teeth=12, diameter=44, width=6, tooth_depth=4, gap=1.2, lash=2.0, turn=None,
            names=('RatchetWheel', 'Pawl'), controls=(None, None)):
    """A ratchet wheel that turns clockwise (seen from the tip of `axis`) and is locked against turning back by a gravity pawl; returns two joints.

    pivot: wheel centre on the base's mounting face. axis: direction away from the base. up: world direction of the pawl
    side, perpendicular to axis; the pawl hangs on its own captive post above the wheel there and its weight drops the round
    nose into the gap between teeth, so the axis must be roughly horizontal. There is no spring: a printed spring is rigid
    in the checker. lash is the back-turn in mm at the wheel rim before the nose catches; gap is the nose-to-tooth clearance. The base must be flat and
    reach 30 mm around the wheel. The wheel joint covers a clockwise turn of `turn` degrees (default half a tooth pitch):
    the checker always drives a joint back to zero, which the locked direction forbids once the nose has dropped past a tooth tip.
    The pawl joint covers its lift (0 to 12 degrees).
    """
    if teeth < 8 or diameter < 40:
        raise ValueError('ratchet: use at least 8 teeth and a diameter of at least 40 mm')
    outer = diameter / 2
    root = outer - tooth_depth
    pitch = 360.0 / teeth
    turn = 0.5 * pitch if turn is None else turn
    if not 6 < turn <= 0.55 * pitch:
        raise ValueError('ratchet: turn must be above 6 degrees and at most %.1f (55 percent of a tooth pitch)' % (0.55 * pitch))
    flat = 0.12
    xdir = direction(up).cross(direction(axis))
    world = frame(pivot, axis, xdir)
    wheel_standoff, pawl_standoff, end_play = 0.5, 0.0, 0.3
    seat = pawl_standoff + end_play
    zmid = seat + width / 2
    wheel_zmid = wheel_standoff + end_play + width / 2
    pawl_at = (-0.77 * outer, 1.136 * outer)

    def ramp_r(delta):
        return root if delta <= flat * pitch else root + tooth_depth * (delta - flat * pitch) / (pitch - flat * pitch)

    points = []
    for k in range(teeth):
        face = math.radians(90 + (k - 1) * pitch)
        step = math.radians(pitch)
        points += [(root * math.cos(face), root * math.sin(face)), (root * math.cos(face + flat * step), root * math.sin(face + flat * step))]
        for i in range(1, 13):
            r, t = root + tooth_depth * i / 12, face + flat * step + (1 - flat) * step * i / 12
            points.append((r * math.cos(t), r * math.sin(t)))
    wheel = place(prism(names[0], points, width, (0, 0, wheel_zmid)), world)

    nose_r = 2.0
    nose_x = -lash - nose_r
    surface = []
    for i in range(0, 300):
        delta = i * pitch / 300
        r = ramp_r(delta)
        surface.append((-r * math.sin(math.radians(delta)), r * math.cos(math.radians(delta))))
    nose_y = root
    while any(math.hypot(x - nose_x, y - nose_y) < nose_r + gap for x, y in surface):
        nose_y += 0.05
    nose = cylinder('_nose', nose_r, width, (nose_x, nose_y, zmid))
    run = Vector((nose_x - pawl_at[0], nose_y - pawl_at[1]))
    side = Vector((-run.y, run.x)).normalized() * 1.8
    bar = prism('_bar', [(pawl_at[0] + side.x, pawl_at[1] + side.y), (nose_x + side.x, nose_y + side.y), (nose_x - side.x, nose_y - side.y),
                         (pawl_at[0] - side.x, pawl_at[1] - side.y)], width, (0, 0, zmid))
    pawl = cylinder(names[1], 5.5, width, (pawl_at[0], pawl_at[1], zmid))
    join(pawl, bar)
    join(pawl, nose)
    place(pawl, world)

    axle = _captive_axle()
    wheel_joint = axle(base, wheel, pivot, axis, width=width, standoff=wheel_standoff, limits=(-turn, 0), control=controls[0], name=names[0] + 'Axle')
    pawl_point = tuple(world @ Vector((pawl_at[0], pawl_at[1], 0)))
    pawl_joint = axle(base, pawl, pawl_point, axis, width=width, standoff=pawl_standoff, recess=False, limits=(0, 12), control=controls[1], name=names[1] + 'Axle')
    return [wheel_joint, pawl_joint]


# ---------------------------------------------------------------- crank and slider

def crank_slider(base, pivot, axis, slide, crank_radius=10, rod_length=40, width=6, rod_thickness=4, post_diameter=4, crank_axle=6,
                 rod_range=(-5.5, 5.5), crank_range=(-10, 10), slider_range=(-3, 3), names=('Crank', 'ConnectingRod', 'Slider'), controls=(None, None, None)):
    """A crank disc, a connecting rod and a slider with a slotted guide; returns three joints (crank, slider, rod).

    pivot: the crank axle centre on the base's mounting face. axis: direction away from the base. slide: direction the
    slider moves (perpendicular to axis). The saved pose has the crank pin on the +(axis x slide) side, level with the axle,
    so the slider sits sqrt(rod_length^2 - crank_radius^2) from the axle and can travel 2 x crank_radius in all.
    The crank turns on a captive post. The rod rides on collars of integral headed pins on the crank and the slider.
    The slider has two slots over headed posts that stand on the base, so it can neither lift nor turn.
    The base must be flat and reach rod_length + 45 mm past the axle along `slide` and 16 mm to each side of the slide line.
    rod_range, crank_range and slider_range are the movement the checker drives (degrees, degrees, mm); the checker cannot drive
    this closed loop through its full cycle, so they are short (see the card). The rod joint is parented to the crank:
    the rod-to-slider pin is not declared, because a part with two parents makes the checker skip all movement checks.
    """
    if rod_length < 3 * crank_radius:
        raise ValueError('crank_slider: rod_length must be at least 3 x crank_radius')
    if rod_thickness < 3:
        raise ValueError('crank_slider: rod_thickness must be at least 3 mm')
    clearance, overhang, head_height, end_play = 0.3, 1.2, 2.5, 0.3
    stem = post_diameter / 2
    bore = stem + clearance
    head = bore + overhang
    world = frame(pivot, axis, slide)
    seat = end_play                                    # discs and the slider sit 0.3 mm above the base, flat
    top = seat + width
    lift = 1.5                                         # the rod rides on pin collars, not on the flat tops
    rod_seat = top + lift + end_play
    zmid = seat + width / 2
    radius, length = crank_radius, rod_length
    run = math.sqrt(length ** 2 - radius ** 2)
    low, high = (length - radius) - run, (length + radius) - run

    crank = place(cylinder(names[0], radius + 6, width, (0, 0, zmid), segments=96), world)
    pin_world = world @ Matrix.Translation((0, radius, top))
    _headed_post(crank, pin_world, (0, 0), stem, head, lift + rod_thickness + 2 * end_play, lift, head_height)

    slider_half = 14
    slot_length = (high - low) + 2 * bore
    shift = (low + high) / 2
    posts = ((run + 4.0, 9.5), (run + 16.0, -9.5))              # diagonal posts: the slider can neither turn nor tip
    block_lo = min(x for x, _ in posts) - shift - slot_length / 2 - 2
    block_hi = max(x for x, _ in posts) - shift + slot_length / 2 + 2
    slider = place(box2(names[2], (block_lo, -slider_half, seat), (block_hi, slider_half, top)), world)
    for x, y in posts:
        cut(slider, place(prism('_slot', _stadium(slot_length, 2 * bore), width + 4, (x - shift, y, zmid)), world))
        _headed_post(base, world, (x, y), stem, head, top + end_play, 0.0, head_height)
    slider_pin = world @ Matrix.Translation((run, 0, top))
    _headed_post(slider, slider_pin, (0, 0), stem, head, lift + rod_thickness + 2 * end_play, lift, head_height)

    eye = 4.5
    spread = Vector((run, -radius))
    angle = math.atan2(spread.y, spread.x)
    link = _stadium(spread.length + 2 * eye, 2 * eye)
    middle = (Vector((0, radius)) + Vector((run, 0))) / 2
    outline = [(middle.x + x * math.cos(angle) - y * math.sin(angle), middle.y + x * math.sin(angle) + y * math.cos(angle)) for x, y in link]
    rod = prism(names[1], outline, rod_thickness, (0, 0, rod_seat + rod_thickness / 2))
    cut(rod, cylinder('_bore1', bore, rod_thickness + 2, (0, radius, rod_seat + rod_thickness / 2)),
        cylinder('_bore2', bore, rod_thickness + 2, (run, 0, rod_seat + rod_thickness / 2)))
    place(rod, world)

    crank_joint = _captive_axle()(base, crank, pivot, axis, width=width, axle_diameter=crank_axle, standoff=0.0, limits=crank_range,
                                  control=controls[0], name=names[0] + 'Axle')
    slide_world = world @ Vector((run, 0, zmid))
    slider_joint = joint(names[2] + 'Guide', 'prismatic', base, slider, slide, tuple(slide_world), (low, high), controls[2])
    pin_point = tuple(world @ Vector((0, radius, rod_seat)))
    rod_joint = joint(names[1] + 'CrankPin', 'revolute', crank, rod, axis, pin_point, rod_range, controls[1])
    return [crank_joint, slider_joint, rod_joint]


# ---------------------------------------------------------------- cam and follower

def cam_follower(base, pivot, axis, up, cam_radius=11, eccentricity=3.5, width=6, stem_diameter=6, cam_axle=6,
                 names=('Cam', 'Follower'), controls=(None, None)):
    """An eccentric cam on a captive post lifting a flat-footed follower that cannot leave its guide; returns two joints.

    pivot: the cam axle centre on the base's mounting face. axis: direction away from the base. up: the direction the
    follower moves, perpendicular to axis (gravity should pull it back down onto the cam). The follower is one solid:
    a flat foot under a guide bridge, a stem through the bridge's hole and a head above it, so it cannot fall out or
    lift out. The bridge is part of the base, an arch standing on it. The saved pose is the cam at its lowest, the foot
    0.3 mm above it; the cam lifts the follower 2 x eccentricity. The base must be flat and reach 22 mm beside the axle
    and 70 mm along `up`.
    """
    if eccentricity < 1 or cam_radius - eccentricity < 7:
        raise ValueError('cam_follower: use eccentricity of at least 1 and a cam radius at least 7 mm larger than it')
    clearance, end_play = 0.3, 0.3
    world = frame(pivot, axis, up)
    lift = 2 * eccentricity
    seat = end_play
    zf = 7.0                                            # follower stem height above the base face
    stem = stem_diameter / 2
    hole = stem + clearance
    foot_x = cam_radius - eccentricity + clearance      # underside of the foot at rest
    foot_t, guide_t, head_t = 2.5, 8.0, 2.5
    bridge_lo = foot_x + foot_t + lift + clearance
    bridge_hi = bridge_lo + guide_t
    plate_half = hole + 3.5
    reach = cam_radius + eccentricity + clearance + 2.5
    top_z = zf + hole + 3

    cam = place(cylinder(names[0], cam_radius, width, (-eccentricity, 0, seat + width / 2), segments=96), world)
    arch = box2('_arch', (-6, -reach - 4, -2), (bridge_hi, reach + 4, top_z))
    cut(arch, box2('_room', (-7, -reach, -3), (bridge_lo, reach, top_z + 1)))
    cut(arch, place(cylinder('_hole', hole, guide_t + 4, (0, 0, 0), axis='X'), Matrix.Translation(((bridge_lo + bridge_hi) / 2, 0, zf))))
    join(base, place(arch, world))
    require_one_solid(base, 'cam_follower', 'Make the base reach the guide arch, about %.0f mm along `up` and %.0f mm to each side.' % (bridge_hi, reach + 4))

    plate_r = min(plate_half, zf - seat - 0.2)
    foot = box2(names[1], (foot_x, -(reach - clearance), seat), (foot_x + foot_t, reach - clearance, seat + width))
    join(foot, cylinder('_stem', stem, bridge_hi + clearance + head_t - foot_x, ((foot_x + bridge_hi + clearance + head_t) / 2, 0, zf), axis='X'))
    join(foot, cylinder('_head', plate_r, head_t, (bridge_hi + clearance + head_t / 2, 0, zf), axis='X'))
    place(foot, world)

    cam_joint = _captive_axle()(base, cam, pivot, axis, width=width, axle_diameter=cam_axle, standoff=0.0, limits=(-180, 180),
                                control=controls[0], name=names[0] + 'Axle')
    follower_joint = joint(names[1] + 'Guide', 'prismatic', base, foot, up, tuple(world @ Vector((foot_x + foot_t / 2, 0, zf))), (0, lift - 1.0), controls[1])
    return [cam_joint, follower_joint]


# ---------------------------------------------------------------- detent slider

def detent_slider(base, pivot, axis, slide, positions=3, pitch=8, width=6, post_diameter=4, limits=None, name='Slider', control=None):
    """A slider held on two integral headed posts with a spring arm whose bump clicks into notches in a rail; returns its prismatic joint.

    pivot: slider centre, with the bump in the middle notch, on the base's mounting face. axis: direction away from the base.
    slide: the direction it slides (perpendicular to axis). The slider has a slot over the two posts, so it cannot lift or leave;
    the slot ends stop it 0.3 mm beyond the (positions - 1) x pitch travel. An arm on its +(axis x slide) side carries
    a bump that rests in the middle of `positions` notches (odd), `pitch` apart, in a rail fixed to the base.
    The base must be flat and reach 50 mm along `slide` and 18 mm to the bump side of the pivot.
    limits default to +-pitch/2. The checker's arm is rigid, yet with pitch 8 it passed +-4 mm of drive through the
    notches; +-6 and +-8 mm gave 0.2 mm penetration readings.
    """
    if positions < 3 or positions % 2 == 0 or pitch < 6:
        raise ValueError('detent_slider: use an odd number of positions, at least 3, and a pitch of at least 6 mm')
    clearance, overhang, head_height, end_play = 0.3, 1.2, 2.5, 0.3
    stem = post_diameter / 2
    bore = stem + clearance
    head = bore + overhang
    world = frame(pivot, axis, slide)
    seat = end_play
    top = seat + width
    zmid = seat + width / 2
    travel = (positions - 1) * pitch
    limits = (-pitch / 2, pitch / 2) if limits is None else limits
    spacing = 2 * head + 0.6
    slot_length = spacing + 2 * bore + travel
    half_width = 6.0
    block_half = slot_length / 2 + 4
    slider = place(box2(name, (-block_half, -half_width, seat), (block_half, half_width, top)), world)
    cut(slider, place(prism('_slot', _stadium(slot_length, 2 * bore), width + 4, (0, 0, zmid)), world))
    for x in (-spacing / 2, spacing / 2):
        _headed_post(base, world, (x, 0), stem, head, top + end_play, 0.0, head_height)

    bump_r, thick, notch_r = 1.5, 1.2, 1.8
    bump_x = block_half + 12
    rail_y = half_width + clearance
    bump_y = rail_y + 0.5 - bump_r                               # the bump tip rests 0.5 mm past the rail face, in a notch
    arm = box2('_arm', (block_half - 1, bump_y - thick, seat), (bump_x, bump_y, top))
    join(arm, cylinder('_bump', bump_r, width, (bump_x, bump_y, zmid)))
    join(slider, place(arm, world))
    rail = box2('_rail', (bump_x - travel / 2 - 3, rail_y, -2), (bump_x + travel / 2 + 3, rail_y + 6, top))
    for k in range(positions):
        cut(rail, cylinder('_notch', notch_r, width + 4, (bump_x + (k - (positions - 1) / 2) * pitch, rail_y, zmid)))
    join(base, place(rail, world))
    require_one_solid(base, 'detent_slider', 'Make the base reach the rail, about %.0f mm to the bump side of the pivot.' % (rail_y + 6))
    require_one_solid(slider, 'detent_slider', 'The slider arm did not fuse with the slider.')
    return joint(name + 'Guide', 'prismatic', base, slider, slide, tuple(world @ Vector((0, 0, zmid))), limits, control)


# ---------------------------------------------------------------- flexure spring

def _serpentine(beams, length, pitch):
    """Centre line of a serpentine of `beams` straight runs along y joined by round folds; starts and ends 1 mm below y = 0."""
    points = [(0.0, -1.0), (0.0, 0.0)]
    for k in range(beams - 1):
        top = k % 2 == 0
        centre, y = k * pitch + pitch / 2, length if top else 0.0
        if top:
            points.append((k * pitch, length))
        for i in range(1, 24):
            angle = math.pi * (1 - i / 24) if top else math.pi * (1 + i / 24)
            points.append((centre + pitch / 2 * math.cos(angle), y + pitch / 2 * math.sin(angle)))
        points.append(((k + 1) * pitch, y))
        points.append(((k + 1) * pitch, length if top else 0.0))
    points.append(((beams - 1) * pitch, -1.0))
    clean = []
    for point in points:
        if not clean or math.hypot(point[0] - clean[-1][0], point[1] - clean[-1][1]) > 1e-6:
            clean.append(point)
    return clean


def flexure_spring(name, pivot, axis='+Z', pull='+X', beams=6, beam_length=16, thickness=1.2, pitch=4.4, height=8,
                   block=(12, 8), hole_diameter=3.4):
    """One printed piece: two mounting blocks joined by a serpentine of beams that bends when the blocks move along `pull`.

    pivot: centre of the spring's footprint on its mounting plane. axis: the direction the height rises (print with it
    pointing up). pull: the direction the blocks move apart or together (perpendicular to axis). beams must be even
    so both blocks sit on the same side. Each block has a vertical hole of hole_diameter for a screw or pin. Returns the
    part; join it to your model with `join` or print it alone.
    """
    if beams < 2 or beams % 2:
        raise ValueError('flexure_spring: beams must be an even number, at least 2')
    if thickness < 0.8 or pitch - thickness < 2.0 or beam_length < 6 * thickness:
        raise ValueError('flexure_spring: use thickness >= 0.8, a gap between beams (pitch - thickness) >= 2 and beam_length >= 6 x thickness')
    line = _serpentine(beams, beam_length, pitch)
    count = len(line)
    left, right = [], []
    for i, (x, y) in enumerate(line):
        ax, ay = line[max(i - 1, 0)]
        bx, by = line[min(i + 1, count - 1)]
        size = math.hypot(bx - ax, by - ay)
        nx, ny = -(by - ay) / size, (bx - ax) / size
        left.append((x + nx * thickness / 2, y + ny * thickness / 2))
        right.append((x - nx * thickness / 2, y - ny * thickness / 2))
    part = prism(name, left + right[::-1], height, (0, 0, height / 2))
    last = (beams - 1) * pitch
    for edge, side in ((0, -1), (last, 1)):
        low = edge + 1.6 - block[0] if side < 0 else edge - 1.6
        pad = box2('_block', (low, -block[1], 0), (low + block[0], 0.5, height))
        join(part, pad)
        cut(part, cylinder('_hole', hole_diameter / 2, height + 2, (low + block[0] / 2 + side * 0.8, -block[1] / 2, height / 2)))
        join(part, prism('_root', [(edge - 1.6, -0.5), (edge + 1.6, -0.5), (edge + thickness / 2, 2.0), (edge - thickness / 2, 2.0)], height, (0, 0, height / 2)))
    xlo, xhi = -block[0] + 1.6, last + block[0] - 1.6
    move(part, (-(xlo + xhi) / 2, -(beam_length - block[1]) / 2, 0))
    part = place(part, frame(pivot, axis, pull))
    require_one_solid(part, 'flexure_spring', 'Check beams, pitch and thickness: the serpentine must be one connected piece.')
    return part
