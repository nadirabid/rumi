"""Separate-print mechanism recipes: spur gear, gear pair, rack & pinion, ratchet, cam & follower, detent slider, flexure spring, living hinge.

Every movable mechanism mounts on separate-print bayonet axles/posts with removable locking caps.
Kit names (and `bayonet_axle` from `wheels.py`) are injected by `cad/rumi_joints.py`.
"""
import math

_PRESSURE = math.radians(20)


def _inv(angle):
    return math.tan(angle) - angle


def _gear_outline(teeth, module, backlash, tip_trim, phase=0.0):
    """Closed CCW 20-degree involute gear outline with tooth 0 centred on +u."""
    pitch_r = module * teeth / 2.0
    base_r = pitch_r * math.cos(_PRESSURE)
    root_r = pitch_r - 1.25 * module
    tip_r = pitch_r + module - tip_trim
    half = (math.pi * module / 2.0 - backlash / 2.0) / (2.0 * pitch_r)

    def angle(r):
        return half + _inv(_PRESSURE) - _inv(math.acos(min(1.0, base_r / r)))

    if angle(tip_r) * tip_r * 2.0 < 0.4:
        raise ValueError('spur_gear: teeth are pointed (tip < 0.4 mm); use more teeth, larger module, or smaller backlash')
    start = max(base_r, root_r)
    radii = [start + (tip_r - start) * i / 8.0 for i in range(9)]
    pts = []
    for k in range(teeth):
        centre = phase + 2.0 * math.pi * k / teeth
        right, left = [], []
        if base_r > root_r:
            right.append((root_r, centre - angle(base_r)))
            left.append((root_r, centre + angle(base_r)))
        for r in radii:
            right.append((r, centre - angle(r)))
            left.append((r, centre + angle(r)))
        tip = [(tip_r, centre - angle(tip_r) + 2.0 * angle(tip_r) * j / 4.0) for j in range(1, 4)]
        for r, a in right + tip + left[::-1]:
            pts.append((r * math.cos(a), r * math.sin(a)))
        a0 = centre + angle(max(base_r, root_r))
        a1 = centre + 2.0 * math.pi / teeth - angle(max(base_r, root_r))
        for j in range(1, 4):
            a = a0 + (a1 - a0) * j / 4.0
            pts.append((root_r * math.cos(a), root_r * math.sin(a)))
    return pts


def _bayonet_post_and_cap(parent, world, local_xy, shaft_r, z_cap, standoff, cap_name, cap_r, clearance=0.35, turn=90.0):
    """Fuse a smooth bayonet post onto `parent` at `local_xy` in `world` and return the placed locking cap."""
    cutters, cap_local, z_tip, _ = _build_bayonet_tip_and_cap(
        shaft_r, z_cap, cap_name, cap_r, clearance=clearance, turn=turn
    )
    post = cylinder('_post', shaft_r, z_tip + 2.0, (0, 0, (z_tip - 2.0) / 2.0))
    if standoff > 0:
        join(post, cylinder('_shoulder', cap_r + 1.0, standoff + 2.0, (0, 0, (standoff - 2.0) / 2.0)))
    for cutter in cutters:
        cut(post, cutter)
    post_frame = world.translated((local_xy[0], local_xy[1], 0.0))
    join(parent, place(post, post_frame))
    cap = place(cap_local, post_frame)
    return cap, post_frame.origin


# ---------------------------------------------------------------- spur gear & gear pair

def spur_gear(name, teeth, pivot, axis, module=2, width=6, xdir=None, phase_degrees=0, backlash=0.8, tip_trim=0, end_play=0.35, standoff=1.0):
    """Flat-printable involute spur gear blank (20 deg pressure angle) ready for `bayonet_axle` or `snap_axle`."""
    if teeth < 12 or module < 1.5:
        raise ValueError('spur_gear: use at least 12 teeth and module >= 1.5')
    if backlash < 0.7:
        raise ValueError('spur_gear: backlash must be >= 0.7 mm to maintain >= 0.3 mm flank clearance')
    outline = _gear_outline(teeth, module, backlash, tip_trim, math.radians(phase_degrees))
    part = prism(name, outline, width, (0, 0, standoff + end_play + width / 2.0))
    return place(part, frame(pivot, axis, xdir))


def gear_pair(
    base,
    pivot,
    axis,
    teeth_a,
    teeth_b,
    toward=None,
    module=2,
    width=6,
    axle_diameter=7.0,
    backlash=0.8,
    limits=None,
    stagger=0.5,
    names=('GearA', 'GearB'),
    controls=(None, None),
):
    """5-part separate-print meshing spur gear pair: `base` + 2 gears + 2 quarter-turn bayonet hub caps."""
    if min(teeth_a, teeth_b) < 14:
        raise ValueError('gear_pair: use at least 14 teeth on each gear')
    if limits is None:
        limits = (-180, 180) if max(teeth_a, teeth_b) <= 1.45 * min(teeth_a, teeth_b) else (-15, 15)
    spacing = module * (teeth_a + teeth_b) / 2.0
    world = frame(pivot, axis, toward)
    line = world.x_dir
    centre_b = tuple(Vec3(pivot) + line * spacing)
    reach = spacing * math.sin(_PRESSURE)

    def trim(count):
        pitch_r = module * count / 2.0
        base_r = pitch_r * math.cos(_PRESSURE)
        return max(0.0, pitch_r + module - (math.sqrt(base_r ** 2 + reach ** 2) - 0.1))

    cap_r = axle_diameter / 2.0 + 0.35 + 2.0
    if module * min(teeth_a, teeth_b) / 2.0 - 1.25 * module < cap_r + 1.0:
        raise ValueError('gear_pair: smaller gear root is too small for the bayonet axle cap; use more teeth or larger module')

    gear_a = spur_gear(names[0], teeth_a, pivot, axis, module, width, toward, 0.0, backlash, trim(teeth_a), standoff=1.0)
    gear_b = spur_gear(names[1], teeth_b, centre_b, axis, module, width, tuple(-line), 180.0 / teeth_b, backlash, trim(teeth_b), standoff=1.0 + stagger)

    res_a = bayonet_axle(base, gear_a, pivot, axis, width=width, axle_diameter=axle_diameter, standoff=1.0, cap_diameter=2.0 * cap_r, limits=limits, control=controls[0], name=gear_a.name + 'Axle')
    res_b = bayonet_axle(base, gear_b, centre_b, axis, width=width, axle_diameter=axle_diameter, standoff=1.0 + stagger, cap_diameter=2.0 * cap_r, limits=limits, control=controls[1], name=gear_b.name + 'Axle')

    all_joints = list(res_a.joints) + list(res_b.joints)
    created = [gear_a, *res_a.parts, gear_b, *res_b.parts]
    steps = list(res_a.steps) + list(res_b.steps)
    features = [_record_badge_feature('gear-pair', [base, *created], all_joints)]
    return RecipeResult(all_joints, parts=created, steps=steps, features=features, gear_a=gear_a, gear_b=gear_b, cap_a=res_a.cap, cap_b=res_b.cap)


# ---------------------------------------------------------------- rack and pinion

def _rack_outline(teeth, module, backlash, back, addendum, offset):
    """20-degree straight-flank rack outline with pitch line at `y = offset` and teeth pointing `+y`."""
    pitch = math.pi * module
    tan = math.tan(_PRESSURE)
    half_tooth = (pitch / 2.0 - backlash / 2.0) / 2.0
    root = -1.25 * module
    top_half = half_tooth - addendum * tan
    root_half = half_tooth - root * tan
    pts = [(-teeth * pitch / 2.0, root - back), (teeth * pitch / 2.0, root - back), (teeth * pitch / 2.0, root)]
    for k in range(teeth - 1, -1, -1):
        centre = (k - (teeth - 1) / 2.0) * pitch
        pts += [(centre + root_half, root), (centre + top_half, addendum), (centre - top_half, addendum), (centre - root_half, root)]
    pts.append((-teeth * pitch / 2.0, root))
    return [(x, y + offset) for x, y in pts]


def rack_pinion(
    base,
    pivot,
    axis,
    slide,
    pinion_teeth=16,
    module=2,
    width=6,
    travel=30,
    backlash=0.8,
    back=13.0,
    post_diameter=6.5,
    pinion_axle=7.0,
    names=('Pinion', 'Rack'),
    controls=(None, None),
):
    """Separate-print rack & pinion: pinion on a bayonet axle + slotted rack guided on two bayonet-capped posts."""
    pitch_r = module * pinion_teeth / 2.0
    pitch = math.pi * module
    addendum = min(module, pitch_r * math.sin(_PRESSURE) ** 2 - 0.15)
    if pinion_teeth < 12 or addendum < 0.8:
        raise ValueError('rack_pinion: use at least 12 pinion teeth')
    if travel / 2.0 / pitch_r * 180.0 / math.pi > 180.0:
        raise ValueError('rack_pinion: travel requires more than half a turn of the pinion; shorten travel or add teeth')
    if post_diameter < 6.0:
        raise ValueError('rack_pinion: post_diameter must be at least 6.0 mm for bayonet guide caps')

    clearance, end_play, standoff = 0.35, 0.35, 0.0
    post_r = post_diameter / 2.0
    bore = post_r + clearance
    cap_r = bore + 1.8
    if back < 2.0 * bore + 4.2:
        raise ValueError(f'rack_pinion: back must be at least {2.0 * bore + 4.2:.1f} mm for post_diameter {post_diameter:.1f}')

    spacing = 2.0 * cap_r + 1.4
    slot_length = spacing + 2.0 * bore + travel
    teeth = max(math.ceil(travel / pitch) + 3, math.ceil((slot_length + 6.0) / pitch))
    teeth += 1 - teeth % 2
    world = frame(pivot, axis, slide)
    seat = standoff + end_play
    zmid = seat + width / 2.0
    slot_y = -pitch_r - 1.25 * module - back / 2.0

    outline = _rack_outline(teeth, module, backlash, back, addendum, -pitch_r)
    rack = place(prism(names[1], outline, width, (0, 0, zmid)), world)
    slot = prism('_slot', _stadium_points(slot_length, 2.0 * bore), width + 4.0, (0, slot_y, zmid))
    cut(rack, place(slot, world))

    ax = direction(axis)
    rack_caps = []
    cap_joints = []
    cap_steps = []
    for idx, x in enumerate((-spacing / 2.0, spacing / 2.0), start=1):
        cap, post_origin = _bayonet_post_and_cap(
            base, world, (x, slot_y), post_r, seat + width + end_play, standoff,
            f'{names[1]}Cap{idx}', cap_r, clearance=clearance, turn=90.0,
        )
        rack_caps.append(cap)
        cap_joints.append(joint(cap.name + 'Lock', 'fixed', base, cap, axis=ax, pivot=post_origin, retainer='bayonet'))
    require_one_solid(base, 'rack_pinion', f'Make base reach the rack posts ({-slot_y:.0f} mm to the rack side of pivot).')

    pinion = spur_gear(names[0], pinion_teeth, pivot, axis, module, width, slide, -90.0 - 180.0 / pinion_teeth, backlash, standoff=0.5)
    turn_deg = travel / 2.0 / pitch_r * 180.0 / math.pi
    res_p = bayonet_axle(
        base, pinion, pivot, axis, width=width, axle_diameter=pinion_axle, standoff=0.5,
        limits=(-turn_deg, turn_deg), control=controls[0], name=names[0] + 'Axle',
    )

    centre = tuple(world.to_world((0, slot_y, zmid)))
    rack_joint = joint(names[1] + 'Slide', 'prismatic', base, rack, slide, centre, (-travel / 2.0, travel / 2.0), controls[1])

    all_parts = [base, pinion, res_p.cap, rack, *rack_caps]
    for cap, x in zip(rack_caps, (-spacing / 2.0, spacing / 2.0)):
        post_origin = world.to_world((x, slot_y, 0.0))
        cap_steps.append(step_twist(cap, post_origin, ax, -90.0, pull=ax * _clear_distance(cap, all_parts, ax)))
    rack_step = step_translate(rack, ax * _clear_distance(rack, [base, pinion], ax))

    all_joints = [*res_p.joints, rack_joint, *cap_joints]
    created = [pinion, *res_p.parts, rack, *rack_caps]
    steps = [*res_p.steps, *cap_steps, rack_step]
    features = [_record_badge_feature('rack-and-pinion', [base, *created], all_joints)]
    return RecipeResult(all_joints, parts=created, steps=steps, features=features, pinion=pinion, rack=rack, pinion_cap=res_p.cap, rack_caps=rack_caps)


# ---------------------------------------------------------------- ratchet

def ratchet(
    base,
    pivot,
    axis,
    up,
    teeth=12,
    diameter=44,
    width=6,
    tooth_depth=4,
    gap=1.2,
    lash=2.0,
    turn=None,
    axle_diameter=7.0,
    names=('RatchetWheel', 'Pawl'),
    controls=(None, None),
):
    """Separate-print gravity-pawl ratchet: wheel + pawl on separate bayonet axles with locking caps."""
    if teeth < 8 or diameter < 40:
        raise ValueError('ratchet: use at least 8 teeth and diameter >= 40 mm')
    outer = diameter / 2.0
    root = outer - tooth_depth
    pitch = 360.0 / teeth
    turn_deg = 0.4 * pitch if turn is None else float(turn)
    if not (6.0 < turn_deg <= 0.55 * pitch):
        raise ValueError(f'ratchet: turn must be in (6, {0.55 * pitch:.1f}] degrees')
    flat = 0.14
    tip_land = 0.10
    xdir = direction(up).cross(direction(axis))
    world = frame(pivot, axis, xdir)
    # Stagger wheel and pawl by 0.5 mm along axis so their flat faces are never coplanar during meshing.
    wheel_standoff, pawl_standoff, end_play = 0.5, 0.0, 0.35
    seat = pawl_standoff + end_play
    zmid = seat + width / 2.0
    wheel_zmid = wheel_standoff + end_play + width / 2.0
    pawl_at = (-0.77 * outer, 1.136 * outer)

    def ramp_r(delta):
        if delta <= flat * pitch:
            return root
        if delta >= (1.0 - tip_land) * pitch:
            return outer
        return root + tooth_depth * (delta - flat * pitch) / ((1.0 - flat - tip_land) * pitch)

    pts = []
    for k in range(teeth):
        face = math.radians(90.0 + (k - 1) * pitch)
        step = math.radians(pitch)
        pts += [(root * math.cos(face), root * math.sin(face)), (root * math.cos(face + flat * step), root * math.sin(face + flat * step))]
        ramp_span = 1.0 - flat - tip_land
        for i in range(1, 11):
            r = root + tooth_depth * i / 10.0
            t = face + (flat + ramp_span * i / 10.0) * step
            pts.append((r * math.cos(t), r * math.sin(t)))
        # Rounded/flat tooth tip land (avoids 0-width knife edge in Bullet GImpact).
        pts.append((outer * math.cos(face + (1.0 - tip_land * 0.5) * step), outer * math.sin(face + (1.0 - tip_land * 0.5) * step)))
        pts.append((outer * math.cos(face + 0.995 * step), outer * math.sin(face + 0.995 * step)))
    wheel_part = place(prism(names[0], pts, width, (0, 0, wheel_zmid)), world)

    nose_r = 2.0
    nose_x = -lash - nose_r
    surface = [(-ramp_r(i * pitch / 300.0) * math.sin(math.radians(i * pitch / 300.0)),
                ramp_r(i * pitch / 300.0) * math.cos(math.radians(i * pitch / 300.0))) for i in range(300)]
    nose_y = root
    while any(math.hypot(x - nose_x, y - nose_y) < nose_r + gap for x, y in surface):
        nose_y += 0.05
    nose = cylinder('_nose', nose_r, width, (nose_x, nose_y, zmid))
    chamfer(nose, 0.45)
    run_x, run_y = nose_x - pawl_at[0], nose_y - pawl_at[1]
    run_len = math.hypot(run_x, run_y)
    sx, sy = -run_y / run_len * 2.0, run_x / run_len * 2.0
    bar = prism('_bar', [
        (pawl_at[0] + sx, pawl_at[1] + sy), (nose_x + sx, nose_y + sy),
        (nose_x - sx, nose_y - sy), (pawl_at[0] - sx, pawl_at[1] - sy),
    ], width, (0, 0, zmid))
    pawl = cylinder(names[1], max(6.0, axle_diameter / 2.0 + 2.8), width, (pawl_at[0], pawl_at[1], zmid))
    join(pawl, bar, nose)
    place(pawl, world)

    res_w = bayonet_axle(
        base, wheel_part, pivot, axis, width=width, axle_diameter=axle_diameter, standoff=wheel_standoff,
        limits=(-turn_deg, 0.0), control=controls[0], name=names[0] + 'Axle',
    )
    pawl_point = tuple(world.to_world((pawl_at[0], pawl_at[1], 0.0)))
    res_p = bayonet_axle(
        base, pawl, pawl_point, axis, width=width, axle_diameter=axle_diameter, standoff=pawl_standoff,
        limits=(0.0, 12.0), control=controls[1], name=names[1] + 'Axle',
    )

    all_joints = [*res_w.joints, *res_p.joints]
    created = [wheel_part, *res_w.parts, pawl, *res_p.parts]
    steps = [*res_w.steps, *res_p.steps]
    return RecipeResult(all_joints, parts=created, steps=steps, wheel=wheel_part, pawl=pawl, wheel_cap=res_w.cap, pawl_cap=res_p.cap)


# ---------------------------------------------------------------- cam and follower

def cam_follower(
    base,
    pivot,
    axis,
    up,
    cam_radius=18,
    eccentricity=3.5,
    width=6,
    stem_diameter=7.5,
    cam_axle=7.0,
    names=('Cam', 'Follower'),
    controls=(None, None),
):
    """Separate-print cam & follower: eccentric cam on bayonet axle + guided follower retained by a keyed snap cap."""
    if eccentricity < 1.0 or cam_radius - eccentricity < 11.0:
        raise ValueError('cam_follower: need eccentricity >= 1.0 and cam_radius - eccentricity >= 11.0 for clean follower disassembly past the cam post')
    if stem_diameter < 6.8:
        raise ValueError('cam_follower: stem_diameter must be at least 6.8 mm so the keyed snap tip slides cleanly through the guide hole')
    clearance, end_play, standoff = 0.35, 0.35, 0.5
    world = frame(pivot, axis, up)
    lift = 2.0 * eccentricity
    seat = standoff + end_play
    zf = 7.8
    stem_r = stem_diameter / 2.0
    hole = stem_r + clearance
    foot_x = cam_radius - eccentricity + clearance
    foot_t, guide_t = 2.5, 4.5
    bridge_lo = foot_x + foot_t + lift + clearance
    bridge_hi = bridge_lo + guide_t
    reach = cam_radius + eccentricity + clearance + 2.5
    top_z = zf + hole + 3.2

    cam = place(cylinder(names[0], cam_radius, width, (-eccentricity, 0, seat + width / 2.0)), world)
    arch = box2('_arch', (-6.0, -reach - 4.0, -2.0), (bridge_hi, reach + 4.0, top_z))
    cut(arch, box2('_room', (-7.0, -reach, -3.0), (bridge_lo, reach, top_z + 1.0)))
    cut(arch, cylinder('_hole', hole, guide_t + 4.0, ((bridge_lo + bridge_hi) / 2.0, 0, zf), axis='X'))
    join(base, place(arch, world))
    require_one_solid(base, 'cam_follower', f'Make base reach guide arch ({bridge_hi:.0f} mm along up, {reach + 4:.0f} mm sideways).')

    # Compact keyed snap cap on +up tip of Follower's stem: keep barb head_r < hole so Follower slides straight out.
    cap_r = min(hole + 2.4, zf - seat - 0.3)
    if cap_r < hole + 1.2:
        raise ValueError('cam_follower: insufficient room for follower retainer cap')
    z_cap_local = bridge_hi + clearance
    snap_barb = 0.80
    stub_r = max(2.15, hole - clearance - snap_barb - 0.15)
    tip_solid, slot_cutter, cap_local, z_tip, snap_dist = _build_keyed_snap_tip_and_cap(
        stub_r, z_cap_local, names[1] + 'Cap', cap_r, cap_thick=3.0, clearance=clearance, barb=snap_barb, head_height=1.9
    )
    stem_frame = Frame(world.to_world((0, 0, zf)), world.y_dir, world.z_dir, world.x_dir)
    foot = box2(names[1], (foot_x, -(reach - clearance), seat), (foot_x + foot_t, reach - clearance, seat + width))
    stem_local = cylinder('_stem', stem_r, bridge_hi - foot_x, (0, 0, (foot_x + bridge_hi) / 2.0))
    join(stem_local, tip_solid)
    cut(stem_local, slot_cutter)
    place(foot, world)
    join(foot, place(stem_local, stem_frame))
    fcap = place(cap_local, stem_frame)
    require_one_solid(foot, 'cam_follower', 'Follower foot and stem did not fuse.')
    require_one_solid(fcap, 'cam_follower', 'Check stem_diameter.')

    res_cam = bayonet_axle(
        base, cam, pivot, axis, width=width, axle_diameter=cam_axle, standoff=standoff,
        limits=(-180, 180), control=controls[0], name=names[0] + 'Axle',
    )

    up_dir = direction(up)
    ax = direction(axis)
    f_pivot = tuple(world.to_world((foot_x + foot_t / 2.0, 0, zf)))
    fcap_piv = tuple(world.to_world((z_cap_local + 1.5, 0, zf)))
    j_follow = joint(names[1] + 'Guide', 'prismatic', base, foot, up_dir, f_pivot, (0.0, max(2.0, lift - 2.0)), controls[1])
    j_fcap = joint(fcap.name + 'Lock', 'fixed', foot, fcap, pivot=fcap_piv, retainer='snap')

    all_parts = [base, cam, res_cam.cap, foot, fcap]
    fcap_clear = _clear_distance(fcap, all_parts, up_dir)
    fcap_pull = max(0.0, fcap_clear - snap_dist)
    # After FollowerCap, CamCap, and Cam are removed, Follower slides -up cleanly out of the arch (clearing cam post) then +axis.
    arch_exit = (z_tip - bridge_lo) + 0.5
    f_step = dict(
        part=foot.name,
        actions=[
            action_translate((-up_dir) * arch_exit),
            action_translate(ax * _clear_distance(foot, [base], ax)),
        ],
    )
    steps = [
        step_snap(fcap, up_dir * snap_dist, max_interference_mm=min(2.4, snap_barb + 0.55), pull=(up_dir * fcap_pull) if fcap_pull > 0.5 else None, mate=foot),
        *res_cam.steps,
        f_step,
    ]
    all_joints = [*res_cam.joints, j_follow, j_fcap]
    created = [cam, *res_cam.parts, foot, fcap]
    return RecipeResult(all_joints, parts=created, steps=steps, cam=cam, follower=foot, cam_cap=res_cam.cap, follower_cap=fcap)


# ---------------------------------------------------------------- detent slider

def detent_slider(
    base,
    pivot,
    axis,
    slide,
    positions=3,
    pitch=8,
    width=6,
    post_diameter=6.5,
    limits=None,
    name='Slider',
    control=None,
):
    """Separate-print detent slider: slotted slider + spring bump arm retained on two bayonet-capped posts."""
    if positions < 3 or positions % 2 == 0 or pitch < 6:
        raise ValueError('detent_slider: use an odd number of positions >= 3 and pitch >= 6 mm')
    if post_diameter < 6.0:
        raise ValueError('detent_slider: post_diameter must be at least 6.0 mm for bayonet caps')
    clearance, end_play, standoff = 0.35, 0.35, 0.0
    post_r = post_diameter / 2.0
    bore = post_r + clearance
    cap_r = bore + 1.8
    world = frame(pivot, axis, slide)
    seat = standoff + end_play
    top = seat + width
    zmid = seat + width / 2.0
    travel = (positions - 1) * pitch
    lim = (-pitch / 2.0, pitch / 2.0) if limits is None else limits
    spacing = 2.0 * cap_r + 2.4
    slot_length = spacing + 2.0 * bore + travel
    half_width = max(6.5, bore + 2.4)
    block_half = slot_length / 2.0 + 4.0

    slider = place(box2(name, (-block_half, -half_width, seat), (block_half, half_width, top)), world)
    cut(slider, place(prism('_slot', _stadium_points(slot_length, 2.0 * bore), width + 4.0, (0, 0, zmid)), world))

    ax = direction(axis)
    caps = []
    cap_joints = []
    for idx, x in enumerate((-spacing / 2.0, spacing / 2.0), start=1):
        cap, post_origin = _bayonet_post_and_cap(
            base, world, (x, 0.0), post_r, top + end_play, standoff,
            f'{name}Cap{idx}', cap_r, clearance=clearance, turn=90.0,
        )
        caps.append(cap)
        cap_joints.append(joint(cap.name + 'Lock', 'fixed', base, cap, axis=ax, pivot=post_origin, retainer='bayonet'))

    # Side-mounted detent bump centred at x = 0 so guide-post yaw produces zero lever-arm swing into the rail.
    bump_r, thick, notch_r = 1.5, 1.4, 2.2
    arm_gap = 1.8
    bump_x = 0.0
    bump_y = half_width + arm_gap + thick
    rail_y = bump_y + bump_r + clearance + 0.15
    root_x = -min(block_half - 2.0, 12.0)
    arm_root = box2('_arm_root', (root_x, half_width - 1.0, seat), (root_x + 3.0, bump_y, top))
    arm_beam = box2('_arm_beam', (root_x, bump_y - thick, seat), (bump_x + bump_r * 0.5, bump_y, top))
    bump = cylinder('_bump', bump_r, width, (bump_x, bump_y, zmid))
    chamfer(bump, 0.3)
    join(arm_root, arm_beam, bump)
    join(slider, place(arm_root, world))

    rail = box2('_rail', (-travel / 2.0 - 4.0, rail_y, -2.0), (travel / 2.0 + 4.0, rail_y + 5.5, top + 0.6))
    chamfer(rail, 0.35)
    for k in range(positions):
        cut(rail, cylinder('_notch', notch_r, width + 4.0, ((k - (positions - 1) / 2.0) * pitch, rail_y, zmid)))
    join(base, place(rail, world))

    require_one_solid(base, 'detent_slider', f'Make base reach the rail ({rail_y + 5.5:.0f} mm to the bump side of pivot).')
    require_one_solid(slider, 'detent_slider', 'Slider arm did not fuse with slider.')

    j_slide = joint(name + 'Guide', 'prismatic', base, slider, slide, tuple(world.to_world((0, 0, zmid))), lim, control)
    all_parts = [base, slider, *caps]
    steps = [
        step_twist(caps[0], world.to_world((-spacing / 2.0, 0, 0)), ax, -90.0, pull=ax * _clear_distance(caps[0], all_parts, ax)),
        step_twist(caps[1], world.to_world((spacing / 2.0, 0, 0)), ax, -90.0, pull=ax * _clear_distance(caps[1], all_parts, ax)),
        step_translate(slider, ax * _clear_distance(slider, [base], ax)),
    ]
    return RecipeResult([j_slide, *cap_joints], parts=[slider, *caps], steps=steps, slider=slider, caps=caps)


# ---------------------------------------------------------------- monolithic compliant mechanisms

def _serpentine(beams, length, pitch):
    pts = [(0.0, -1.0), (0.0, 0.0)]
    for k in range(beams - 1):
        top = (k % 2 == 0)
        centre, y = k * pitch + pitch / 2.0, length if top else 0.0
        if top:
            pts.append((k * pitch, length))
        for i in range(1, 20):
            angle = math.pi * (1.0 - i / 20.0) if top else math.pi * (1.0 + i / 20.0)
            pts.append((centre + pitch / 2.0 * math.cos(angle), y + pitch / 2.0 * math.sin(angle)))
        pts.append(((k + 1) * pitch, y))
        pts.append(((k + 1) * pitch, length if top else 0.0))
    pts.append(((beams - 1) * pitch, -1.0))
    clean = []
    for pt in pts:
        if not clean or math.hypot(pt[0] - clean[-1][0], pt[1] - clean[-1][1]) > 1e-6:
            clean.append(pt)
    return clean


def flexure_spring(
    name,
    pivot,
    axis='+Z',
    pull='+X',
    beams=6,
    beam_length=16,
    thickness=1.2,
    pitch=4.4,
    height=8,
    block=(12, 8),
    hole_diameter=3.4,
):
    """One-piece flat-printable serpentine flexure spring with two mounting blocks."""
    if beams < 2 or beams % 2:
        raise ValueError('flexure_spring: beams must be an even integer >= 2')
    if thickness < 0.8 or pitch - thickness < 2.0 or beam_length < 6.0 * thickness:
        raise ValueError('flexure_spring: need thickness >= 0.8, pitch - thickness >= 2.0, beam_length >= 6 * thickness')
    line = _serpentine(beams, beam_length, pitch)
    count = len(line)
    left, right = [], []
    for i, (x, y) in enumerate(line):
        ax, ay = line[max(i - 1, 0)]
        bx, by = line[min(i + 1, count - 1)]
        size = math.hypot(bx - ax, by - ay)
        nx, ny = -(by - ay) / size, (bx - ax) / size
        left.append((x + nx * thickness / 2.0, y + ny * thickness / 2.0))
        right.append((x - nx * thickness / 2.0, y - ny * thickness / 2.0))
    part = prism(name, left + right[::-1], height, (0, 0, height / 2.0))
    last = (beams - 1) * pitch
    for edge, side in ((0.0, -1.0), (last, 1.0)):
        lo = edge + 1.6 - block[0] if side < 0 else edge - 1.6
        join(part, box2('_block', (lo, -block[1], 0.0), (lo + block[0], 0.5, height)))
        cut(part, cylinder('_hole', hole_diameter / 2.0, height + 2.0, (lo + block[0] / 2.0 + side * 0.8, -block[1] / 2.0, height / 2.0)))
        join(part, prism('_root', [(edge - 1.6, -0.5), (edge + 1.6, -0.5), (edge + thickness / 2.0, 2.0), (edge - thickness / 2.0, 2.0)], height, (0, 0, height / 2.0)))
    xlo, xhi = -block[0] + 1.6, last + block[0] - 1.6
    move(part, (-(xlo + xhi) / 2.0, -(beam_length - block[1]) / 2.0, 0.0))
    place(part, frame(pivot, axis, pull))
    require_one_solid(part, 'flexure_spring', 'Check beams, pitch, and thickness.')
    return part


def living_hinge(name, pivot, axis, across='X', panel_width=18, panel_thickness=3, length=30, web_thickness=0.5, web_length=2):
    """One-piece flat-printable flexible living hinge (for PP/PETG/TPU). Returns the part with badge evidence."""
    half = web_length / 2.0
    relief = panel_thickness - web_thickness
    if relief < 0.5:
        raise ValueError('living_hinge: panel_thickness must exceed web_thickness by at least 0.5 mm')
    if web_thickness < 0.4:
        raise ValueError('living_hinge: web_thickness must be at least 0.4 mm')
    if panel_width < half + relief + 1.0:
        raise ValueError(f'living_hinge: panel_width must be at least {half + relief + 1.0:.1f} mm')
    outline = [
        (-panel_width, 0.0), (panel_width, 0.0), (panel_width, panel_thickness),
        (half + relief, panel_thickness), (half, web_thickness), (-half, web_thickness),
        (-half - relief, panel_thickness), (-panel_width, panel_thickness),
    ]
    part = prism(name, outline, length, pivot, axis, across)
    feat = _record_badge_feature('living-hinge', [part], [])
    part.meta.setdefault('_rumi_features', []).append(feat)
    return part
