"""Separate-print linear slider recipes: dovetail slide, T-slot rail, telescoping tube, pin in a slot.

Every slider prints as flat separate pieces with open assembly entry and a removable locking end-stop
or mouth collar. Kit names are injected by `cad/rumi_joints.py`.
"""
import math

_STOP_GAP = 0.5


def _slider_frame(recipe, pivot, axis, up):
    if abs(direction(axis).dot(direction(up))) > 1e-3:
        raise ValueError(f'{recipe}: axis (sliding direction) and up (out of parent surface) must be perpendicular')
    return frame(pivot, up, axis)


def _check_surface(recipe, parent, world):
    top = _local_extents(parent, world)[2][1]
    if abs(top) > 0.5:
        raise ValueError(f'{recipe}: parent surface is {top:.1f} mm from pivot along up; place pivot on that surface')


def _lift_child(child, world, clearance):
    """Trim child underside to `3 * clearance` above the parent face so slider walls carry the load cleanly."""
    lift = 3.0 * clearance
    cut(child, place(box2('_below', (-500, -500, -500), (500, 500, lift)), world))


def _stadium_prism(name, radius, half, z0, z1):
    pts = _stadium_points(2.0 * (half + radius), 2.0 * radius)
    return prism(name, pts, z1 - z0, (0, 0, (z0 + z1) / 2.0))


def dovetail_slide(
    parent,
    child,
    pivot,
    axis,
    up,
    travel=30,
    length=16,
    stem_width=6,
    head_width=10,
    head_height=5,
    neck_depth=3,
    clearance=0.35,
    neck_clearance=0.8,
    stop_length=8.0,
    barb=0.9,
    limits=None,
    control=None,
    name=None,
    stop_name=None,
):
    """3-part separate-print dovetail slide: open-ended dovetail rail on `parent` + carriage `child` + snap-in end-stop plug.

    The groove is closed at `-axis` and open at `+axis` so the carriage slides in cleanly after separate printing.
    The separate end-stop plug snaps into the open `+axis` end and locks with a floor barb.
    """
    if clearance < 0.3:
        raise ValueError('dovetail_slide: clearance must be at least 0.3 mm')
    world = _slider_frame('dovetail_slide', pivot, axis, up)
    slope = 0.57735  # tan(30 deg)
    chamber = head_height + 2.0 * clearance
    slot_half = length / 2.0 + travel / 2.0 + _STOP_GAP
    neck = stem_width / 2.0 + neck_clearance
    top = head_width / 2.0 + clearance
    bottom = top + chamber * slope
    _check_surface('dovetail_slide', parent, world)
    (x_lo, x_hi), (y_lo, y_hi), (z_lo, _) = _local_extents(parent, world)

    need_z = neck_depth + chamber + barb + 2.2
    need_y = bottom + 1.8
    need_x_lo = slot_half + 2.0
    need_x_hi = slot_half + stop_length
    if neck >= top or -z_lo < need_z or min(-y_lo, y_hi) < need_y or -x_lo < need_x_lo or x_hi < need_x_hi:
        raise ValueError(
            f'dovetail_slide: parent needs depth >= {need_z:.1f}, half-width >= {need_y:.1f}, '
            f'-axis >= {need_x_lo:.1f}, +axis >= {need_x_hi:.1f} (got {-z_lo:.1f}, {min(-y_lo, y_hi):.1f}, {-x_lo:.1f}, {x_hi:.1f})'
        )
    child_top = _local_extents(child, world)[2][1]
    if child_top < 3.0 * clearance + 3.0:
        raise ValueError(f'dovetail_slide: child must reach at least {3.0 * clearance + 3.0:.1f} mm above parent face')

    # Open-ended dovetail groove from -slot_half all the way out past x_hi.
    groove_len = (x_hi + 2.0) - (-slot_half)
    groove_cx = (-slot_half + x_hi + 2.0) / 2.0
    groove_pts = [
        (-neck, 1.0), (neck, 1.0), (neck, -neck_depth), (top, -neck_depth),
        (bottom, -neck_depth - chamber), (-bottom, -neck_depth - chamber),
        (-top, -neck_depth), (-neck, -neck_depth),
    ]
    cut(parent, place(prism('_groove', groove_pts, groove_len, (groove_cx, 0, 0), 'X', 'Y'), world))

    # Floor snap catch pocket near the open +axis mouth for the end-stop plug's barb.
    floor_z = -neck_depth - chamber
    pocket_x1 = x_hi - 1.6
    pocket_x0 = pocket_x1 - 2.2
    barb_w = max(3.6, head_width * 0.55)
    cut(parent, place(box2('_catch', (pocket_x0, -barb_w / 2.0 - clearance - 0.3, floor_z - barb - 0.7),
                           (pocket_x1, barb_w / 2.0 + clearance + 0.3, floor_z + 0.5)), world))
    require_one_solid(parent, 'dovetail_slide', 'The groove split the parent; make it thicker or wider.')

    # Carriage key on child.
    _lift_child(child, world, clearance)
    inset = clearance / 0.866025
    key_top = -neck_depth - clearance
    key_bot = -neck_depth - chamber + clearance
    half_top = top + clearance * slope - inset
    half_bot = top + (chamber - clearance) * slope - inset
    key = prism('_key', [(-half_top, key_top), (half_top, key_top), (half_bot, key_bot), (-half_bot, key_bot)], length, (0, 0, 0), 'X', 'Y')
    join(key, prism('_stem', [(-stem_width / 2.0, key_top - 1.0), (stem_width / 2.0, key_top - 1.0),
                              (stem_width / 2.0, 3.0 * clearance + 1.0), (-stem_width / 2.0, 3.0 * clearance + 1.0)],
                    length - 2.0, (0, 0, 0), 'X', 'Y'))
    join(child, place(key, world))
    require_one_solid(child, 'dovetail_slide', 'Make the child cover the groove at the pivot.')

    # Separate snap-in end-stop plug closing the +axis mouth.
    # The plug body terminates 0.8 mm inside x_hi so its side walls never cross Rail's +axis mouth corner;
    # the floor barb inside [pocket_x0, pocket_x1] arrests BOTH +axis and -axis motion, and a narrow centered
    # pull tab extends past x_hi well clear of the groove walls.
    s_label = stop_name or (child.name + 'Stop')
    plug_x0 = slot_half + 0.4
    plug_x1 = x_hi - 0.8
    plug_len = plug_x1 - plug_x0
    plug_cx = (plug_x0 + plug_x1) / 2.0
    stop_local = prism(s_label, [(-half_top, key_top), (half_top, key_top), (half_bot, key_bot), (-half_bot, key_bot)],
                       plug_len, (plug_cx, 0, 0), 'X', 'Y')
    chamfer(stop_local, 0.3)
    tab_half_y = max(1.6, min(stem_width / 2.0 - 0.4, half_top - 1.4))
    tab = box2('_pull_tab', (plug_x1 - 1.5, -tab_half_y, key_bot + 1.0), (x_hi + 2.6, tab_half_y, key_top - 0.2))
    chamfer(tab, 0.3)
    join(stop_local, tab)
    # Relieve the entire plug underside from pocket_x0 - 0.6 onward.
    cut(stop_local, box2('_under_rel', (pocket_x0 - 0.6, -(bottom + 2.0), key_bot - 0.5), (x_hi + 1.0, bottom + 2.0, key_bot + 0.8)))
    # Cantilevered downward snap barb catching BOTH pocket_x0 and pocket_x1 walls cleanly.
    barb_x0 = pocket_x0 + clearance
    barb_x1 = pocket_x1 - clearance
    barb_pts = [(barb_x0, key_bot + 1.4), (barb_x1, key_bot + 1.4), (barb_x1, floor_z - barb), (barb_x0, floor_z - barb)]
    barb_part = prism('_barb', barb_pts, barb_w, (0, 0, 0), '-Y', 'X')
    chamfer(barb_part, 0.25)
    join(stop_local, barb_part)
    # Flex slot inside plug body above barb.
    cut(stop_local, box2('_flex', (plug_x0 - 0.5, -barb_w / 2.0 - 0.5, key_bot + 1.8), (barb_x1 + 1.0, barb_w / 2.0 + 0.5, key_bot + 2.9)))
    stop = place(stop_local, world)
    require_one_solid(stop, 'dovetail_slide', 'Check stop_length and head_height.')

    ax = direction(axis)
    lim = limits if limits is not None else (-travel / 2.0, travel / 2.0)
    stop_piv = tuple(world.to_world((plug_cx, 0, (key_top + key_bot) / 2.0)))
    j_slide = joint(name or (child.name + 'Slide'), 'prismatic', parent, child, ax, pivot, lim, control)
    j_stop = joint(stop.name + 'Lock', 'fixed', parent, stop, pivot=stop_piv, retainer='snap')

    snap_dist = (x_hi - barb_x0) + 1.2
    stop_clear = _clear_distance(stop, [parent, child], ax)
    stop_pull = max(0.0, stop_clear - snap_dist)
    steps = [
        step_snap(stop, ax * snap_dist, max_interference_mm=min(2.4, barb + 0.85), pull=(ax * stop_pull) if stop_pull > 0.5 else None, mate=parent),
        step_translate(child, ax * _clear_distance(child, [parent], ax)),
    ]
    all_joints = [j_slide, j_stop]
    features = [_record_badge_feature('dovetail-slide', [parent, child, stop], all_joints)]
    return RecipeResult(all_joints, parts=[stop], steps=steps, features=features, stop=stop)


def tslot_rail(
    parent,
    child,
    pivot,
    axis,
    up,
    travel=30,
    length=16,
    stem_width=6,
    head_width=12,
    head_height=4,
    neck_depth=3,
    clearance=0.35,
    neck_clearance=0.8,
    stop_length=8.0,
    barb=0.9,
    limits=None,
    control=None,
    name=None,
    stop_name=None,
):
    """3-part separate-print T-slot rail: open-ended T-slot on `parent` + T-slider `child` + snap-in end-stop plug."""
    if clearance < 0.3:
        raise ValueError('tslot_rail: clearance must be at least 0.3 mm')
    world = _slider_frame('tslot_rail', pivot, axis, up)
    chamber = head_height + 2.0 * clearance
    slot_half = length / 2.0 + travel / 2.0 + _STOP_GAP
    neck = stem_width / 2.0 + neck_clearance
    wide = head_width / 2.0 + clearance
    _check_surface('tslot_rail', parent, world)
    (x_lo, x_hi), (y_lo, y_hi), (z_lo, _) = _local_extents(parent, world)

    need_z = neck_depth + chamber + barb + 2.2
    need_y = wide + 1.8
    need_x_lo = slot_half + 2.0
    need_x_hi = slot_half + stop_length
    if -z_lo < need_z or min(-y_lo, y_hi) < need_y or -x_lo < need_x_lo or x_hi < need_x_hi:
        raise ValueError(
            f'tslot_rail: parent needs depth >= {need_z:.1f}, half-width >= {need_y:.1f}, '
            f'-axis >= {need_x_lo:.1f}, +axis >= {need_x_hi:.1f}'
        )
    child_top = _local_extents(child, world)[2][1]
    if child_top < 3.0 * clearance + 3.0:
        raise ValueError(f'tslot_rail: child must reach at least {3.0 * clearance + 3.0:.1f} mm above parent face')

    groove_len = (x_hi + 2.0) - (-slot_half)
    groove_cx = (-slot_half + x_hi + 2.0) / 2.0
    slot_pts = [
        (-neck, 1.0), (neck, 1.0), (neck, -neck_depth), (wide, -neck_depth),
        (wide, -neck_depth - chamber), (-wide, -neck_depth - chamber),
        (-wide, -neck_depth), (-neck, -neck_depth),
    ]
    cut(parent, place(prism('_slot', slot_pts, groove_len, (groove_cx, 0, 0), 'X', 'Y'), world))

    floor_z = -neck_depth - chamber
    pocket_x1 = x_hi - 1.6
    pocket_x0 = pocket_x1 - 2.2
    barb_w = max(3.6, head_width * 0.5)
    cut(parent, place(box2('_catch', (pocket_x0, -barb_w / 2.0 - clearance - 0.3, floor_z - barb - 0.7),
                           (pocket_x1, barb_w / 2.0 + clearance + 0.3, floor_z + 0.5)), world))
    require_one_solid(parent, 'tslot_rail', 'The T-slot split the parent; make it thicker or wider.')

    _lift_child(child, world, clearance)
    stem = stem_width / 2.0
    head = wide - clearance
    top_of_head = -neck_depth - clearance
    bot_of_head = top_of_head - head_height
    slider = prism('_head', [(-head, bot_of_head), (head, bot_of_head), (head, top_of_head), (-head, top_of_head)], length, (0, 0, 0), 'X', 'Y')
    join(slider, prism('_stem', [(-stem, top_of_head - 1.0), (stem, top_of_head - 1.0),
                                 (stem, 3.0 * clearance + 1.0), (-stem, 3.0 * clearance + 1.0)],
                       length - 2.0, (0, 0, 0), 'X', 'Y'))
    join(child, place(slider, world))
    require_one_solid(child, 'tslot_rail', 'Make the child cover the T-slot at the pivot.')

    # Separate snap-in T-shaped end-stop plug.
    # The plug body terminates 0.8 mm inside x_hi so its side walls never cross Rail's +axis mouth corner;
    # the floor barb inside [pocket_x0, pocket_x1] arrests BOTH +axis and -axis motion, and a narrow centered
    # pull tab extends past x_hi well clear of the T-slot walls.
    s_label = stop_name or (child.name + 'Stop')
    plug_x0 = slot_half + 0.4
    plug_x1 = x_hi - 0.8
    plug_len = plug_x1 - plug_x0
    plug_cx = (plug_x0 + plug_x1) / 2.0
    stop_local = prism(s_label, [(-head, bot_of_head), (head, bot_of_head), (head, top_of_head), (-head, top_of_head)],
                       plug_len, (plug_cx, 0, 0), 'X', 'Y')
    chamfer(stop_local, 0.3)
    tab_half_y = max(1.6, min(stem_width / 2.0 - 0.4, head - 1.6))
    tab = box2('_pull_tab', (plug_x1 - 1.5, -tab_half_y, bot_of_head + 1.0), (x_hi + 2.6, tab_half_y, top_of_head - 0.2))
    chamfer(tab, 0.3)
    join(stop_local, tab)
    cut(stop_local, box2('_under_rel', (pocket_x0 - 0.6, -(wide + 2.0), bot_of_head - 0.5), (x_hi + 1.0, wide + 2.0, bot_of_head + 0.8)))
    barb_x0 = pocket_x0 + clearance
    barb_x1 = pocket_x1 - clearance
    barb_pts = [(barb_x0, bot_of_head + 1.4), (barb_x1, bot_of_head + 1.4), (barb_x1, floor_z - barb), (barb_x0, floor_z - barb)]
    barb_part = prism('_barb', barb_pts, barb_w, (0, 0, 0), '-Y', 'X')
    chamfer(barb_part, 0.25)
    join(stop_local, barb_part)
    cut(stop_local, box2('_flex', (plug_x0 - 0.5, -barb_w / 2.0 - 0.5, bot_of_head + 1.8), (barb_x1 + 1.0, barb_w / 2.0 + 0.5, bot_of_head + 2.8)))
    stop = place(stop_local, world)
    require_one_solid(stop, 'tslot_rail', 'Check stop_length and head_height.')

    ax = direction(axis)
    lim = limits if limits is not None else (-travel / 2.0, travel / 2.0)
    stop_piv = tuple(world.to_world((plug_cx, 0, (top_of_head + bot_of_head) / 2.0)))
    j_slide = joint(name or (child.name + 'Slide'), 'prismatic', parent, child, ax, pivot, lim, control)
    j_stop = joint(stop.name + 'Lock', 'fixed', parent, stop, pivot=stop_piv, retainer='snap')

    snap_dist = (x_hi - barb_x0) + 1.2
    stop_clear = _clear_distance(stop, [parent, child], ax)
    stop_pull = max(0.0, stop_clear - snap_dist)
    steps = [
        step_snap(stop, ax * snap_dist, max_interference_mm=min(2.4, barb + 0.85), pull=(ax * stop_pull) if stop_pull > 0.5 else None, mate=parent),
        step_translate(child, ax * _clear_distance(child, [parent], ax)),
    ]
    return RecipeResult([j_slide, j_stop], parts=[stop], steps=steps, stop=stop)


def telescoping_tube(
    parent,
    child,
    pivot,
    axis,
    tube_diameter=14,
    travel=24,
    flange_thickness=4,
    collar_depth=9.0,
    clearance=0.35,
    neck_clearance=0.5,
    lock=3.0,
    stop_gap=0.4,
    turn=45,
    limits=None,
    control=None,
    name=None,
    collar_name=None,
):
    """3-part separate-print telescoping tube: outer open-chamber tube `parent` + flanged rod `child` + twist-lock mouth collar.

    Un-twist the bayonet mouth collar and pull it off over the inner rod, then slide the flanged rod straight out.
    """
    if clearance < 0.3 or neck_clearance < 0.35:
        raise ValueError('telescoping_tube: clearance >= 0.3 mm and neck_clearance >= 0.35 mm required')
    world = frame(pivot, axis)
    tube = tube_diameter / 2.0
    mouth = tube + neck_clearance
    flange = mouth + 2.0
    chamber = flange + clearance
    z_collar_bot = -collar_depth
    z_flange_top = z_collar_bot - stop_gap - travel / 2.0
    z0 = z_flange_top - flange_thickness
    floor_top = z0 - travel / 2.0 - stop_gap

    # Bayonet collar dimensions at the tube mouth (z in [-collar_depth, 0]).
    lug_reach = 2.4
    lug_thick = 2.4
    lug_deg = 26.0
    lip = 2.6
    collar_bore = chamber + lock + 1.2
    collar_r = collar_bore - clearance
    lug_r = collar_bore + lug_reach
    slot_r = lug_r + clearance

    _check_surface('telescoping_tube', parent, world)
    (x_lo, x_hi), (y_lo, y_hi), (z_lo, _) = _local_extents(parent, world)
    need_z = -floor_top + 2.0
    need_xy = slot_r + 2.0
    if -z_lo < need_z or min(-x_lo, x_hi) < need_xy or min(-y_lo, y_hi) < need_xy:
        raise ValueError(
            f'telescoping_tube: parent needs depth >= {need_z:.1f} mm and radius >= {need_xy:.1f} mm around mouth '
            f'(got depth {-z_lo:.1f}, half-x {min(-x_lo, x_hi):.1f}, half-y {min(-y_lo, y_hi):.1f})'
        )

    (cx_lo, cx_hi), (cy_lo, cy_hi), (cz_lo, cz_hi) = _local_extents(child, world)
    if max(abs(cx_lo), abs(cx_hi), abs(cy_lo), abs(cy_hi)) > tube + 0.4:
        raise ValueError(f'telescoping_tube: child rod must fit within tube_diameter {tube_diameter:.1f} mm')
    if cz_lo > z0 + flange_thickness - 1.0:
        raise ValueError(f'telescoping_tube: child must extend down to {z0 + flange_thickness - 1.0:.1f} mm behind pivot')

    # Cut open stadium chamber from floor_top straight out through z = 0, plus bayonet socket counterbore at mouth.
    cut(parent, place(_stadium_prism('_chamber', chamber, lock, floor_top, 1.5), world))
    cut(parent, place(cylinder('_cbore', collar_bore, collar_depth + 1.5, (0, 0, (-collar_depth + 1.5) / 2.0)), world))

    ch_h = lug_thick + 2.0 * clearance + 0.35
    z_ch_hi = -lip
    z_ch_lo = z_ch_hi - ch_h
    if z_ch_lo < z_collar_bot + 0.4:
        raise ValueError('telescoping_tube: collar_depth is too shallow for the bayonet lip and lug')
    deg_pad = math.degrees(math.asin(min(0.6, (clearance + 0.08) / collar_bore)))
    entry_half = lug_deg / 2.0 + deg_pad

    c_label = collar_name or (child.name + 'Collar')
    # Leave extra vertical margin above the counterbore floor so under gravity the collar rests on its top rim against z=0.
    collar_bot_z = -collar_depth + clearance + 0.55
    collar_top_z = clearance + 1.0
    collar_local = cylinder(c_label, collar_r, collar_top_z - collar_bot_z, (0, 0, (collar_bot_z + collar_top_z) / 2.0))
    # Top lip flange bears strictly on Outer's unbroken outer ring outside slot_r + 0.5 (never straddling entry slots).
    top_rim = lathe('_top_rim', [
        (collar_r - 0.5, clearance + 0.55),
        (slot_r + 0.5, clearance + 0.55),
        (slot_r + 0.5, clearance),
        (slot_r + 2.6, clearance),
        (slot_r + 2.6, clearance + 2.6),
        (collar_r - 0.5, clearance + 2.6),
    ])
    join(collar_local, top_rim)
    # Smooth central rod bore straight through the entire collar height.
    cut(collar_local, cylinder('_rod_bore', mouth, collar_depth * 2.0 + 12.0, (0, 0, -collar_depth / 2.0)))

    # Bevel bayonet lip edge at z_ch_hi AND the top counterbore mouth rim at z=0 so collar bears on flat interior faces.
    bev = 0.45
    cut(parent, place(lathe('_lip_bev', [
        (collar_bore - 0.5, z_ch_hi), (collar_bore + bev, z_ch_hi),
        (collar_bore, z_ch_hi + bev), (collar_bore - 0.5, z_ch_hi + bev),
    ]), world))
    cut(parent, place(lathe('_mouth_bev', [
        (collar_bore - 0.5, 0.5), (collar_bore + 0.65, 0.5),
        (collar_bore + 0.65, 0.0), (collar_bore, -0.65), (collar_bore - 0.5, -0.65),
    ]), world))

    for idx in range(2):
        entry = 180.0 * idx
        locked = entry + turn
        lo_a = min(entry, locked) - entry_half
        hi_a = max(entry, locked) + entry_half
        cut(
            parent,
            place(_sector_prism(collar_bore - 1.0, slot_r, entry - entry_half, entry + entry_half, z_ch_lo, 1.5), world),
            place(_sector_prism(collar_bore - 1.0, slot_r, lo_a, hi_a, z_ch_lo, z_ch_hi), world),
        )
        lug = _sector_prism(collar_r - 1.0, lug_r, locked - lug_deg / 2.0, locked + lug_deg / 2.0, z_ch_lo + clearance + 0.35, z_ch_hi - clearance)
        join(collar_local, lug)

    require_one_solid(parent, 'telescoping_tube', 'The chamber or bayonet slots split the parent; widen the parent.')

    # Inner flanged rod on child.
    cut(child, place(box2('_below', (-500, -500, -500), (500, 500, z0 + 1.2)), world))
    join(child, place(_stadium_prism('_flange', flange, lock, z0, z0 + flange_thickness), world))
    require_one_solid(child, 'telescoping_tube', 'Extend the child rod down into the chamber to meet the flange.')

    collar = place(collar_local, world)
    require_one_solid(collar, 'telescoping_tube', 'Check tube_diameter and collar_depth.')

    ax = direction(axis)
    lim = limits if limits is not None else (-travel / 2.0, travel / 2.0)
    j_slide = joint(name or (child.name + 'Slide'), 'prismatic', parent, child, ax, pivot, lim, control)
    j_collar = joint(collar.name + 'Lock', 'fixed', parent, collar, axis=ax, pivot=pivot, retainer='bayonet')

    steps = [
        step_twist(collar, pivot, ax, -turn, pull=ax * _clear_distance(collar, [parent, child], ax)),
        step_translate(child, ax * _clear_distance(child, [parent], ax)),
    ]
    return RecipeResult([j_slide, j_collar], parts=[collar], steps=steps, collar=collar)


def pin_slot(
    parent,
    child,
    pivot,
    axis,
    up,
    travel=24,
    pin_diameter=7.5,
    pin_length=16,
    head_overhang=3.0,
    head_height=2.8,
    clearance=0.35,
    turn=90,
    limits=None,
    control=None,
    name=None,
    pin_name=None,
    cap_name=None,
):
    """4-part separate-print pin-in-slot slider: slotted plate `parent` + bored block `child` + separate stadium pin + keyed snap cap.

    The parent plate gets a clean straight-through stadium slot (no buried bridges). The separate headed
    stadium pin rises from underneath `parent` through `child` and locks on top with a keyed snap cap.
    """
    if clearance < 0.3:
        raise ValueError('pin_slot: clearance must be at least 0.3 mm')
    if pin_diameter < 6.8 or pin_length < pin_diameter + 3.0:
        raise ValueError('pin_slot: need pin_diameter >= 6.8 mm and pin_length >= pin_diameter + 3 mm')
    world = _slider_frame('pin_slot', pivot, axis, up)
    _check_surface('pin_slot', parent, world)

    pin_r = pin_diameter / 2.0
    bore_r = pin_r + clearance
    pin_half = pin_length / 2.0 - pin_r
    reach = travel / 2.0 + _STOP_GAP
    (x_lo, x_hi), (y_lo, y_hi), (z_lo, _) = _local_extents(parent, world)
    need_x = reach + pin_half + bore_r + 2.0
    need_y = bore_r + 2.0
    if -z_lo < 2.5 or min(-y_lo, y_hi) < need_y or min(-x_lo, x_hi) < need_x:
        raise ValueError(
            f'pin_slot: parent needs thickness >= 2.5, half-width >= {need_y:.1f}, half-length >= {need_x:.1f}'
        )
    (_, child_top) = _local_extents(child, world)[2]
    lift = 3.0 * clearance
    if child_top < lift + 3.0:
        raise ValueError(f'pin_slot: child must reach at least {lift + 3.0:.1f} mm above parent face')

    # Through stadium slot in parent plate with 0.45 mm chamfered top/bottom rims (zero overhangs).
    cut(parent, place(_stadium_prism('_slot', bore_r, reach + pin_half, z_lo - 2.0, 2.0), world))
    for z_face, inward in ((0.0, -1.0), (z_lo, 1.0)):
        pts_o = _stadium_points(2.0 * (reach + pin_half + bore_r + 0.9), 2.0 * (bore_r + 0.9))
        pts_i = _stadium_points(2.0 * (reach + pin_half + bore_r), 2.0 * bore_r)
        wo = b3d.Wire.make_polygon([(u, v, z_face - inward * 0.45) for u, v in pts_o] + [(pts_o[0][0], pts_o[0][1], z_face - inward * 0.45)])
        wi = b3d.Wire.make_polygon([(u, v, z_face + inward * 0.45) for u, v in pts_i] + [(pts_i[0][0], pts_i[0][1], z_face + inward * 0.45)])
        cut(parent, place(_register('_slot_bev', b3d.Solid.make_loft([wo, wi], ruled=True)), world))
    require_one_solid(parent, 'pin_slot', 'The slot split the parent plate; widen or lengthen the plate.')

    # Lift child off parent face and add two chamfered bearing skids well outside the slot rim.
    _lift_child(child, world, clearance)
    (cx_lo, cx_hi), (cy_lo, cy_hi), _ = _local_extents(child, world)
    skid_y_in = bore_r + 2.2
    skid_y_out = min(abs(cy_lo), abs(cy_hi)) - 0.8
    if skid_y_out > skid_y_in + 1.0:
        sx0, sx1 = cx_lo + 0.8, cx_hi - 0.8
        for sign in (1.0, -1.0):
            y0, y1 = sorted((sign * skid_y_in, sign * skid_y_out))
            skid = box2('_skid', (sx0, y0, clearance), (sx1, y1, lift + 1.0))
            chamfer(skid, 0.35)
            join(child, place(skid, world))
    cut(child, place(_stadium_prism('_cbore', bore_r, pin_half, -1.0, child_top + 2.0), world))
    require_one_solid(child, 'pin_slot', 'The pin bore split the child; make the child wider around the pivot.')

    # Separate headed stadium pin + keyed snap cap on top of child (full 6-DOF locked so it rides cleanly during sliding).
    z_head_top = z_lo - clearance
    z_head_bot = z_head_top - head_height
    z_cap = child_top + clearance
    head_r = bore_r + head_overhang
    cap_r = max(pin_length / 2.0 + clearance + 1.8, head_r)

    p_label = pin_name or (child.name + 'Pin')
    c_label = cap_name or (child.name + 'PinCap')
    snap_barb = 0.80
    # Keep barb head_r = stub_r + clearance + snap_barb < bore_r so the pin slides straight down through Block and Plate.
    stub_r = max(2.15, bore_r - clearance - snap_barb - 0.15)
    tip_solid, slot_cutter, cap_local, _, snap_dist = _build_keyed_snap_tip_and_cap(
        stub_r, z_cap, c_label, cap_r, cap_thick=3.4, clearance=clearance, barb=snap_barb, head_height=2.0
    )
    pin_local = _stadium_prism(p_label, pin_r, pin_half, z_head_bot, child_top)
    join(
        pin_local,
        _stadium_prism('_head', head_r, pin_half, z_head_bot, z_head_top),
        tip_solid,
    )
    cut(pin_local, slot_cutter)

    pin = place(pin_local, world)
    cap = place(cap_local, world)
    require_one_solid(pin, 'pin_slot', 'Check pin_diameter and pin_length.')
    require_one_solid(cap, 'pin_slot', 'Check pin_diameter and pin_length.')

    ax = direction(axis)
    up_dir = direction(up)
    cap_piv = tuple(world.to_world((0, 0, z_cap + 1.7)))
    lim = limits if limits is not None else (-travel / 2.0, travel / 2.0)
    j_slide = joint(name or (child.name + 'Slide'), 'prismatic', parent, child, ax, pivot, lim, control)
    j_pin = joint(pin.name + 'Key', 'fixed', child, pin, pivot=pivot, retainer='rigid')
    j_cap = joint(cap.name + 'Lock', 'fixed', pin, cap, pivot=cap_piv, retainer='snap')

    all_parts = [parent, child, pin, cap]
    cap_clear = _clear_distance(cap, all_parts, up_dir)
    cap_pull = max(0.0, cap_clear - snap_dist)
    steps = [
        step_snap(cap, up_dir * snap_dist, max_interference_mm=min(2.4, snap_barb + 0.55), pull=(up_dir * cap_pull) if cap_pull > 0.5 else None, mate=pin),
        step_translate(pin, (-up_dir) * _clear_distance(pin, [parent, child], -up_dir)),
        step_translate(child, up_dir * _clear_distance(child, [parent], up_dir)),
    ]
    return RecipeResult([j_slide, j_pin, j_cap], parts=[pin, cap], steps=steps, pin=pin, cap=cap)
