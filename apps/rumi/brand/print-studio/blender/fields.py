"""Data-only displacement fields shared by preview recipes and Blender saves."""
import math


def validate_fields(recipe):
    """Reject malformed or discontinuous fields before editing any meshes."""
    fields, values = recipe.get('fields'), recipe.get('values')
    if not isinstance(fields, list) or not 1 <= len(fields) <= 12 or not isinstance(values, dict):
        raise ValueError('Provide 1–12 fields and numeric values')
    keys = set()
    for field in fields:
        key = field.get('key')
        if key not in values or key in keys:
            raise ValueError('Invalid field binding')
        keys.add(key)
        if not isinstance(values[key], (int, float)) or not math.isfinite(values[key]) or not -1 <= values[key] <= 1:
            raise ValueError('Field values must be within -1..1')
        for name in ['origin', 'spacing', 'dimensions']:
            v = field.get(name)
            if not isinstance(v, list) or len(v) != 3 or any(not isinstance(n, (int, float)) or not math.isfinite(n) for n in v):
                raise ValueError('Invalid field ' + name)
        if any(abs(n) > 100000 for n in field['origin']) or any(not .01 <= n <= 100000 for n in field['spacing']):
            raise ValueError('Invalid field extent')
        if any(not isinstance(n, int) or not 2 <= n <= 16 for n in field['dimensions']):
            raise ValueError('Invalid field dimensions')
        nx, ny, nz = field['dimensions']
        offsets = field.get('offsets')
        if not isinstance(offsets, list) or len(offsets) != nx*ny*nz*3 or any(not isinstance(n, (int, float)) or not math.isfinite(n) or abs(n) > 1000 for n in offsets):
            raise ValueError('Invalid field offsets')
        for z in range(nz):
            for y in range(ny):
                for x in range(nx):
                    if x in (0, nx-1) or y in (0, ny-1) or z in (0, nz-1):
                        i = ((z*ny+y)*nx+x)*3
                        if any(offsets[i:i+3]):
                            raise ValueError('Field boundary offsets must be zero')
    if keys != set(values):
        raise ValueError('Every value must bind a field')


def sample_field(point, field):
    """Return trilinear displacement in millimetres; the exterior stays fixed."""
    q = [(point[i]-field['origin'][i])/field['spacing'][i] for i in range(3)]
    if any(v < 0 or v > field['dimensions'][i]-1 for i, v in enumerate(q)):
        return [0, 0, 0]
    base = [min(math.floor(v), field['dimensions'][i]-2) for i, v in enumerate(q)]
    t = [q[i]-base[i] for i in range(3)]
    result = [0, 0, 0]
    for z in range(2):
        for y in range(2):
            for x in range(2):
                weight = (t[0] if x else 1-t[0])*(t[1] if y else 1-t[1])*(t[2] if z else 1-t[2])
                index = (((base[2]+z)*field['dimensions'][1]+base[1]+y)*field['dimensions'][0]+base[0]+x)*3
                for a in range(3):
                    result[a] += weight*field['offsets'][index+a]
    return result


def field_point(point, recipe):
    """Blend all fields against the same original point, without accumulating edits."""
    result = point.copy()
    for field in recipe['fields']:
        delta = sample_field(point, field)
        for a in range(3):
            result[a] += delta[a]*recipe['values'][field['key']]
    return result
