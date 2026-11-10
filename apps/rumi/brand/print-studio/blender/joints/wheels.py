"""Wheel recipes: a through axle, a seated tyre and an axle retainer. Kit names (cylinder, cut, join, frame, place, joint, ...) are injected by rumi_joints."""


def _rib_ring(part, radius, width, centre, count, rib_height):
    """Fuse `count` radial grip ribs round a wheel at `centre` along local Z."""
    for index in range(count):
        rib = box('_rib', (rib_height + 1.0, max(2.0, radius * 0.12), width - 1.2), (radius + (rib_height - 1.0) / 2, 0, centre))
        rotate(rib, 'Z', 360 * index / count)
        join(part, rib)


def through_axle(parent, child, pivot, axis, body_width, axle_diameter=6, wheel_diameter=30, wheel_width=8,
                 clearance=0.4, end_play=0.3, standoff=1.0, tread=0, limits=(-180, 180), control=None, name=None):
    """One axle through a bore in `parent`, with a wheel fused on each end so both wheels turn together.

    pivot: centre of the bore on the axis, midway through the parent. axis: the axle line. body_width: the parent's
    thickness along the axis there (its two faces are at pivot -/+ body_width / 2); the recipe cuts the bore through it.
    child: a name (str); the recipe makes the axle-and-wheels part, and `bpy.data.objects[name]` fetches it for painting.
    The recipe fuses a bearing ring `standoff` mm thick round the bore on each parent face; the wheels sit `end_play` mm off those rings
    and are wider than the bore, so the whole part cannot leave. It is one solid, so it prints in place and cannot be assembled afterwards.
    tread > 0 adds that many grip ribs to each wheel. Returns the revolute joint record.
    """
    if not isinstance(child, str):
        raise ValueError('through_axle: child must be a name; the recipe makes the axle-and-wheels part')
    radius = axle_diameter / 2
    bore = radius + clearance
    if wheel_diameter / 2 < bore + 2:
        raise ValueError('through_axle: wheel_diameter %.1f is too small for a %.1f mm axle; use at least %.1f' % (wheel_diameter, axle_diameter, 2 * bore + 4))
    if body_width < 2:
        raise ValueError('through_axle: body_width %.1f is too thin' % body_width)
    world = frame(pivot, axis)
    half = body_width / 2
    # A bearing ring on each parent face gives the wheel a clean round flat to bear on, wherever the parent face is large or uneven.
    for sign in (1, -1):
        ring = cylinder('_ring', bore + 3, standoff + 1, (0, 0, sign * (half + (standoff - 1) / 2)))
        join(parent, place(ring, world))
    cut(parent, place(cylinder('_bore', bore, body_width + 2 * standoff + 4), world))

    length = body_width + 2 * (standoff + end_play + wheel_width)
    part = cylinder(child, radius, length)
    for sign in (1, -1):
        centre = sign * (half + standoff + end_play + wheel_width / 2)
        join(part, cylinder('_wheel', wheel_diameter / 2, wheel_width, (0, 0, centre), segments=96))
        if tread:
            _rib_ring(part, wheel_diameter / 2, wheel_width, centre, tread, 2.4)
    place(part, world)
    require_one_solid(parent, 'through_axle', 'The parent must be solid round the bore; keep body_width no larger than the parent is thick at the pivot.')
    return joint(name or child + 'Axle', 'revolute', parent, part, direction(axis), pivot, limits, control)


def _pegged_disc(name, radius, thickness, pegs, peg_radius, height):
    """A disc of `radius` and `thickness` along Z with `pegs` radial round pegs, each of `peg_radius` and `height` mm proud of the rim."""
    disc = cylinder(name, radius, thickness, segments=96)
    for index in range(pegs):
        peg = cylinder('_peg', peg_radius, height + 1, (radius + (height - 1) / 2, 0, 0), 'X', segments=48)
        rotate(peg, 'Z', 360 * index / pegs)
        join(disc, peg)
    return disc


def tyre(parent, child, pivot, axis, hub_diameter, width, tyre_diameter=None, flange=2.0, rim_depth=3.0, gap=0.1,
         pegs=6, peg_diameter=4.0, peg_clearance=0.5, tread=24, tread_height=1.5, control=None, name=None):
    """Seat a separate tyre in a channel cut round a hub. The raised side rims (flanges) hold it on by shape.

    parent: the hub, a solid disc on the axis. pivot: centre of the hub on its axis. axis: the wheel axle direction.
    hub_diameter: the disc's outer (flange) diameter. width: the disc's thickness along the axis.
    child: a name (str); the recipe makes the tyre part, fetched with `bpy.data.objects[name]`.
    The channel floor is `rim_depth` mm below the flange edge and the tyre ring sits `gap` mm clear of the hub.
    pegs: number of round pegs standing on the channel floor that fit pockets in the tyre bore (`peg_clearance` mm
    looser all round), so the tyre cannot spin on the hub; 0 leaves nothing but friction to stop it spinning.
    tyre_diameter: outer diameter over the lugs (default hub_diameter + 8). tread: number of lugs, 0 for a smooth tyre.
    Print the tyre in TPU. Returns a 'fixed' joint record (the tyre turns with the hub).
    """
    if not isinstance(child, str):
        raise ValueError('tyre: child must be a name; the recipe makes the tyre part')
    outer = hub_diameter / 2
    floor = outer - rim_depth
    channel = width - 2 * flange
    if channel < 4 or floor < 6 or rim_depth < 2.5:
        raise ValueError('tyre: hub_diameter %.1f and width %.1f leave no room for a channel; widen the hub, or use rim_depth of at least 2.5 and a floor radius of at least 6' % (hub_diameter, width))
    tyre_outer = (tyre_diameter if tyre_diameter is not None else hub_diameter + 8) / 2
    body_outer = tyre_outer - (tread_height if tread else 0)
    if body_outer < outer + 1:
        raise ValueError('tyre: tyre_diameter %.1f is too small; it must exceed hub_diameter by at least %.1f' % (2 * tyre_outer, 2 + 2 * (tread_height if tread else 0)))
    if peg_diameter > channel - 2 or peg_diameter > rim_depth + 1.5:
        raise ValueError('tyre: peg_diameter %.1f is too large for this channel; use at most %.1f' % (peg_diameter, min(channel - 2, rim_depth + 1.5)))
    world = frame(pivot, axis)
    wide = channel - 2 * gap
    peg_height = min(2.0, rim_depth - 0.8)

    # The channel is a ring of material removed from the hub; the pegs are what the ring leaves standing.
    trench = cylinder('_trench', outer * 1.1 + 3, channel, segments=96)
    cut(trench, _pegged_disc('_core', floor, channel + 2, pegs, peg_diameter / 2, peg_height))
    cut(parent, place(trench, world))

    ring = cylinder(child, body_outer, wide, segments=96)
    for index in range(tread):
        lug = box2('_lug', (body_outer - 0.5, -1.5, -(wide / 2 - 1)), (tyre_outer, 1.5, wide / 2 - 1))
        rotate(lug, 'Z', 360 * index / tread)
        join(ring, lug)
    cut(ring, _pegged_disc('_bore', floor + gap, wide + 2, pegs, peg_diameter / 2 + peg_clearance, peg_height + peg_clearance))
    place(ring, world)
    require_one_solid(parent, 'tyre', 'Make the hub a solid disc at least width mm thick, centred on the pivot.')
    require_one_solid(ring, 'tyre', 'Reduce tread or tread_height.')
    return joint(name or child + 'Seat', 'fixed', parent, ring)


def axle_clip(parent, child, pivot, axis, width=10, axle_diameter=6, clearance=0.3, end_play=0.3, collar_overhang=1.5,
              collar_height=2.0, standoff=1.0, open_clip=False, clip_thickness=1.2, limits=(-180, 180), control=None, name=None):
    """Keep `child` on a stub axle that grows out of `parent`, with a full ring collar at the end of the axle.

    Same layout as `captive_axle`: pivot is on the parent's mounting face, axis points away from the parent, and `child`
    has its hub between standoff + end_play and standoff + end_play + width along the axis (see `wheel`).
    Default: the collar is a plain ring fused to the axle end, wider than the bore by `collar_overhang`, so it cannot come off.
    open_clip=True instead cuts a groove near the axle end and adds a separate open C-clip (a 'fixed' joint to the parent).
    Its opening is narrower than the groove, but the clip can still slide out sideways, so the validator cannot confirm it.
    Returns the revolute joint record, or [revolute, fixed] with open_clip=True.
    """
    radius = axle_diameter / 2
    bore = radius + clearance
    collar_radius = bore + collar_overhang
    base = standoff + end_play
    top = base + width + end_play
    if standoff <= 0:
        raise ValueError('axle_clip: standoff must be positive so the hub bears on a full ring')
    world = frame(pivot, axis)
    shoulder = collar_radius + 2
    cut(child, place(cylinder('_bore', bore, width + 4, (0, 0, base + width / 2)), world))

    if not open_clip:
        profile = [(0, -2), (shoulder, -2), (shoulder, standoff), (radius, standoff), (radius, top), (collar_radius, top),
                   (collar_radius, top + collar_height), (0, top + collar_height)]
    else:
        root = radius - 1.0
        groove_low, groove_high = top - 0.2, top + clip_thickness + 0.2
        profile = [(0, -2), (shoulder, -2), (shoulder, standoff), (radius, standoff), (radius, groove_low), (root, groove_low),
                   (root, groove_high), (radius, groove_high), (radius, groove_high + 1.5), (0, groove_high + 1.5)]
    join(parent, place(lathe('_axle', profile), world))
    require_one_solid(parent, 'axle_clip', 'Put the pivot on the parent surface so the axle root is embedded in it.')
    revolute = joint(name or child.name + 'Axle', 'revolute', parent, child, direction(axis), pivot, limits, control)
    if not open_clip:
        return revolute

    clip = cylinder(child.name + 'Clip', collar_radius, clip_thickness, (0, 0, top + clip_thickness / 2))
    cut(clip, cylinder('_hole', root + 0.05, clip_thickness + 2, (0, 0, top + clip_thickness / 2)),
        box2('_opening', (0, -(root - 0.3), top - 1), (collar_radius + 2, root - 0.3, top + clip_thickness + 1)))
    place(clip, world)
    return [revolute, joint(child.name + 'ClipSeat', 'fixed', parent, clip)]
