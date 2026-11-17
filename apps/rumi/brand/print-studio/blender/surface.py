"""Surface-parameterised deformation shared by preview recipes and Blender saves.

Mirrors ``viewer/analog/surface.js``: displacement is a function of the part's own
declared front angle and selection bounds. Bounds do not depend on triangle
expansion or repeated vertices.
"""
import math

KINDS = ('profile', 'ring', 'channel', 'facet')
AXES = {'profile': ('amount',), 'ring': ('amount',), 'facet': ('amount',), 'channel': ('depth',)}


def wrap_deg(value):
    """Wrap an angle to (-180, 180]."""
    wrapped = (value + 180.0) % 360.0 - 180.0
    return 180.0 if wrapped == -180.0 else wrapped


def smoothstep(edge0, edge1, x):
    t = min(1.0, max(0.0, (x - edge0) / (edge1 - edge0)))
    return t * t * (3.0 - 2.0 * t)


def band_weight(v, lo, hi, edge=.08):
    """Fade in and out over a normalised band."""
    if not hi > lo:
        return 0.0
    fade = min(edge, (hi - lo) / 2.0)
    return smoothstep(lo, lo + fade, v) * (1.0 - smoothstep(hi - fade, hi, v))


def surface_context(points, u_at=-90.0):
    """Bounds are independent of triangle expansion and vertex repetition."""
    if not points:
        raise ValueError('Surface deformation needs visible mesh vertices')
    center = [(min(p[i] for p in points) + max(p[i] for p in points)) / 2 for i in (0, 1)]
    angle = u_at * math.pi / 180
    side_extent = max(abs(-(p[0] - center[0]) * math.sin(angle) + (p[1] - center[1]) * math.cos(angle)) for p in points)
    return {'center': center, 'zMin': min(p[2] for p in points), 'zMax': max(p[2] for p in points), 'uAt': u_at, 'sideExtent': side_extent}


def profile_travel(pairs, x):
    """Continuous first derivatives without overshooting station values."""
    if x <= pairs[0][0]:
        return pairs[0][1]
    for i in range(1, len(pairs)):
        if x <= pairs[i][0]:
            a, va = pairs[i - 1]
            b, vb = pairs[i]
            return va + (vb - va) * smoothstep(a, b, x)
    return pairs[-1][1]


def surface_delta(point, context, form, values, normal=None):
    """Displacement in the declared model frame, in millimetres."""
    dx, dy = point[0] - context['center'][0], point[1] - context['center'][1]
    v = min(1.0, max(0.0, (point[2] - context['zMin']) / max(context['zMax'] - context['zMin'], 1e-6)))
    if form['kind'] == 'facet':
        moved = list(point)
        for plane in form['planes']:
            facing = sum(normal[i] * plane['normal'][i] for i in range(3)) if normal is not None else 0
            if 'wallThickness' in form and normal is None:
                raise ValueError('Shell facets require original surface normals')
            offset = plane['offset'] - (form['wallThickness'] if 'wallThickness' in form and facing < 0 else 0)
            distance = sum(moved[i] * plane['normal'][i] for i in range(3)) - offset
            if 'wallThickness' in form and distance > 0 and band_weight(v, form['from'], form['to'], form.get('edge', .08)) > 0 and abs(facing) < .1:
                raise ValueError('Facet crosses an ambiguous shell edge; narrow the band or reconstruct this region')
            if distance > 0:
                moved = [moved[i] - distance * plane['normal'][i] for i in range(3)]
        weight = values['amount'] * band_weight(v, form['from'], form['to'], form.get('edge', .08))
        return [(moved[i] - point[i]) * weight for i in range(3)]
    angle = context['uAt'] * math.pi / 180
    front = dx * math.cos(angle) + dy * math.sin(angle)
    side = -dx * math.sin(angle) + dy * math.cos(angle)
    if form['kind'] == 'profile':
        height = point[2] - (context['zMin'] + context['zMax']) / 2
        radius = math.hypot(front, height)
        if radius < 1e-6:
            return [0.0, 0.0, 0.0]
        section = .5 + math.atan2(-front, height) / (2 * math.pi)
        def pairs(component):
            result = []
            for i, at in enumerate(form['at']):
                theta = (at - .5) * 2 * math.pi
                direction = form.get('directions', [])[i] if 'directions' in form else [-math.sin(theta), math.cos(theta)]
                key = 'p' + str(form.get('links', {}).get(str(i), i))
                result.append([at, values.get(key, 0) * direction[component]])
            return result
        width = max(context['sideExtent'] / form.get('lateral', 1), 1e-6)
        weight = (1 - smoothstep(width / 2, width, abs(side))) * smoothstep(0, .02, section) * (1 - smoothstep(.98, 1, section))
        along, up = profile_travel(pairs(0), section) * weight, profile_travel(pairs(1), section) * weight
        return [math.cos(angle) * along, math.sin(angle) * along, up]
    radius = math.hypot(dx, dy)
    if radius < 1e-6:
        return [0.0, 0.0, 0.0]
    u_rel = wrap_deg(math.atan2(dy, dx) * 180 / math.pi - context['uAt'])
    amount = 0.0
    if form['kind'] == 'ring':
        amount = values['amount'] * form['millimetres'] * band_weight(v, form['from'], form['to'], form.get('edge', .08))
    elif form['kind'] == 'channel':
        half = form['widthMillimetres'] / (2 * radius)
        across = max(1 - smoothstep(0, half, abs(wrap_deg(u_rel - at)) * math.pi / 180) for at in form['at'])
        amount = -values['depth'] * across * band_weight(v, form['from'], form['to'], form.get('edge', .08))
    return [dx / radius * amount, dy / radius * amount, 0.0]


def surface_point(point, recipe, context, normal=None):
    """Deformed point in model millimetres."""
    delta = surface_delta(point, context, recipe['form'], recipe.get('values', {}), normal)
    return [point[0] + delta[0], point[1] + delta[1], point[2] + delta[2]]


def validate_surface(recipe):
    """Reject malformed surface recipes before editing any meshes."""
    parts = recipe.get('parts')
    if not isinstance(parts, list) or not parts or len(parts) > 16 or any(not isinstance(name, str) or not name for name in parts):
        raise ValueError('Surface deformation needs exact mesh names')
    form = recipe.get('form')
    if not isinstance(form, dict) or form.get('kind') not in KINDS:
        raise ValueError('Choose a surface form: profile, ring, channel or facet')
    kind = form['kind']

    def number(name, low, high):
        value = form.get(name)
        if not isinstance(value, (int, float)) or not math.isfinite(value) or value < low or value > high:
            raise ValueError('Surface ' + name + ' is out of range')
        return float(value)

    axes = AXES[kind]
    if kind == 'profile':
        at = form.get('at')
        if not isinstance(at, list) or not 2 <= len(at) <= 8:
            raise ValueError('A surface profile needs 2-8 knot positions')
        previous = -1.0
        for position in at:
            if not isinstance(position, (int, float)) or not 0 <= position <= 1 or position <= previous:
                raise ValueError('Profile knot positions must rise within 0..1')
            previous = position
        pinned = form.get('pinned', [])
        if not isinstance(pinned, list) or any(type(i) is not int or not 0 <= i < len(at) for i in pinned) or len(set(pinned)) != len(pinned) or len(pinned) == len(at):
            raise ValueError('Pinned profile stations must leave an adjustable station')
        links = form.get('links', {})
        if not isinstance(links, dict) or any(not str(i).isdigit() or not 0 <= int(i) < len(at) or type(target) is not int or not 0 <= target < int(i) or int(i) in pinned or target in pinned or str(target) in links for i, target in links.items()):
            raise ValueError('Profile links must reference an earlier unpinned, unlinked station')
        directions = form.get('directions')
        if directions is not None and (not isinstance(directions, list) or len(directions) != len(at) or any(not isinstance(d, list) or len(d) != 2 or any(not isinstance(n, (int, float)) or not math.isfinite(n) for n in d) or abs(math.hypot(*d) - 1) > 1e-6 for d in directions)):
            raise ValueError('Profile directions need one unit [front, up] vector per station')
        axes = tuple('p' + str(index) for index in range(len(at)) if index not in pinned and str(index) not in links)
    else:
        lo, hi = number('from', 0.0, 1.0), number('to', 0.0, 1.0)
        if not hi > lo:
            raise ValueError('Surface bands need from below to')
        if kind == 'ring':
            number('millimetres', -500.0, 500.0)
        elif kind == 'channel':
            at = form.get('at')
            if not isinstance(at, list) or not 1 <= len(at) <= 4 or any(not isinstance(a, (int, float)) or abs(a) > 180 for a in at):
                raise ValueError('A channel needs 1-4 meridian angles within 180')
            width = number('widthMillimetres', .5, 400.0)
            if width <= 0:
                raise ValueError('Channel width must be positive')
        else:
            planes = form.get('planes')
            if not isinstance(planes, list) or not 1 <= len(planes) <= 12:
                raise ValueError('Facet needs 1-12 target planes')
            for plane in planes:
                normal = plane.get('normal')
                if not isinstance(normal, list) or len(normal) != 3 or any(not isinstance(n, (int, float)) or not math.isfinite(n) for n in normal) or abs(math.hypot(*normal) - 1) > 1e-6:
                    raise ValueError('Facet plane normal must have unit length')
                offset = plane.get('offset')
                if not isinstance(offset, (int, float)) or not math.isfinite(offset) or abs(offset) > 100000:
                    raise ValueError('Invalid facet plane offset')
            for i, plane in enumerate(planes):
                for other in planes[i + 1:]:
                    dot = sum(a * b for a, b in zip(plane['normal'], other['normal']))
                    if abs(dot) > 1e-6 and abs(dot + 1) > 1e-6:
                        raise ValueError('Facet planes must be opposing or perpendicular')
                    if dot < -.999999 and plane['offset'] + other['offset'] <= 2 * form.get('wallThickness', 0):
                        raise ValueError('Opposing facet planes leave no room for the shell')
    if form.get('wallThickness') is not None:
        number('wallThickness', .1, 100)
    if form.get('lateral') is not None:
        number('lateral', 1.0, 8.0)
    if form.get('edge') is not None:
        number('edge', .01, .5)
    values = recipe.get('values')
    required = axes
    if not isinstance(values, dict) or tuple(sorted(values)) != tuple(sorted(required)):
        raise ValueError('Surface ' + kind + ' binds exactly: ' + ', '.join(required))
    for key in required:
        if not isinstance(values[key], (int, float)) or not math.isfinite(values[key]) or abs(values[key]) > 1000:
            raise ValueError('Invalid surface value: ' + key)

    if kind == 'facet' and not 0 <= values['amount'] <= 1:
        raise ValueError('Facet amount must stay within 0..1')
