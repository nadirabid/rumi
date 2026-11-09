"""Author and inspect standard USD Physics joints with Isaac robot annotations, without Kit."""
import json
import math
from pxr import Gf, Sdf, Usd, UsdGeom, UsdPhysics


def initialize_robot(stage):
    """Annotate every exported mesh as a physical link; the first link is the default fixture."""
    root = stage.GetDefaultPrim()
    if not root:
        raise ValueError('USD needs a default robot root')
    root.AddAppliedSchema('IsaacRobotAPI')
    UsdPhysics.ArticulationRootAPI.Apply(root)
    meshes = sorted((prim for prim in stage.Traverse() if prim.IsA(UsdGeom.Mesh)), key=lambda prim: str(prim.GetPath()))
    for prim in meshes:
        prim.AddAppliedSchema('IsaacLinkAPI')
        UsdPhysics.RigidBodyAPI.Apply(prim)
        UsdPhysics.CollisionAPI.Apply(prim)
    root.CreateRelationship('isaac:physics:robotLinks', custom=False).SetTargets([p.GetPath() for p in meshes])
    root.CreateRelationship('isaac:physics:robotJoints', custom=False).SetTargets([])
    root.CreateAttribute('rumi:manufacturingMode', Sdf.ValueTypeNames.Token, custom=False).Set('print-in-place')


def description_layer(stage):
    """Retain robot declarations in the editable .blend without duplicating its mesh geometry."""
    layer = Sdf.Layer.CreateAnonymous()
    for prim in stage.Traverse():
        if prim.IsA(UsdPhysics.Joint):
            Sdf.CreatePrimInLayer(layer, prim.GetPath().GetParentPath())
            Sdf.CopySpec(stage.GetRootLayer(), prim.GetPath(), layer, prim.GetPath())
            continue
        properties = [prop for prop in prim.GetAuthoredProperties() if prop.GetName().startswith(('physics:', 'isaac:', 'rumi:'))]
        if not properties and not prim.HasAuthoredMetadata('apiSchemas'):
            continue
        target = Sdf.CreatePrimInLayer(layer, prim.GetPath())
        if prim.HasAuthoredMetadata('apiSchemas'):
            target.SetInfo('apiSchemas', prim.GetMetadata('apiSchemas'))
        for prop in prim.GetAuthoredProperties():
            if prop.GetName().startswith(('physics:', 'isaac:', 'rumi:')):
                Sdf.CopySpec(stage.GetRootLayer(), prop.GetPath(), layer, prop.GetPath())
    return layer.ExportToString()


def restore_description(stage, text):
    """Compose saved declarations over freshly exported geometry, then flatten the result."""
    layer = Sdf.Layer.CreateAnonymous()
    if not layer.ImportFromString(text):
        raise ValueError('Invalid saved USD robot description')
    composed = Usd.Stage.Open(layer)
    for prim in composed.TraverseAll():
        if prim.IsA(UsdPhysics.Joint):
            stage.DefinePrim(prim.GetPath().GetParentPath(), 'Scope')
            Sdf.CopySpec(layer, prim.GetPath(), stage.GetRootLayer(), prim.GetPath())
            continue
        if not prim.GetAuthoredProperties() and not prim.HasAuthoredMetadata('apiSchemas'):
            continue
        target = stage.GetPrimAtPath(prim.GetPath())
        if not target:
            raise ValueError('A saved robot link is missing: ' + str(prim.GetPath()))
        if prim.HasAuthoredMetadata('apiSchemas'):
            target.SetMetadata('apiSchemas', prim.GetMetadata('apiSchemas'))
        for prop in prim.GetAuthoredProperties():
            Sdf.CopySpec(layer, prop.GetPath(), stage.GetRootLayer(), prop.GetPath())


def read_robot(stage):
    """Project USD links and joint frames to the checker's millimetre/Z-up probe protocol."""
    root = stage.GetDefaultPrim()
    if not root or 'IsaacRobotAPI' not in root.GetAppliedSchemas():
        # Unknown codeless APIs are preserved as authored metadata by OpenUSD.
        if not root or not root.GetMetadata('apiSchemas') or 'IsaacRobotAPI' not in root.GetMetadata('apiSchemas').GetAppliedItems():
            raise ValueError('USD default prim requires IsaacRobotAPI')
    def schemas(prim):
        value = prim.GetMetadata('apiSchemas')
        return value.GetAppliedItems() if value else []
    def value(prim, name, fallback=None):
        result = prim.GetAttribute(name).Get()
        return fallback if result is None else result
    if UsdGeom.GetStageUpAxis(stage) != 'Z' or UsdGeom.GetStageMetersPerUnit(stage) != 1:
        raise ValueError('Publish robot USD in metres with Z up')
    meshes = sorted((prim for prim in stage.Traverse() if prim.IsA(UsdGeom.Mesh)), key=lambda prim: str(prim.GetPath()))
    paths = root.GetRelationship('isaac:physics:robotLinks').GetTargets()
    joints = root.GetRelationship('isaac:physics:robotJoints').GetTargets()
    if not paths or set(paths) != {prim.GetPath() for prim in meshes} or len(paths) != len(meshes):
        raise ValueError('Isaac robotLinks must include each physical mesh exactly once')
    all_joints = [prim for prim in stage.Traverse() if prim.IsA(UsdPhysics.Joint)]
    if len(joints) != len(all_joints) or set(joints) != {prim.GetPath() for prim in all_joints}:
        raise ValueError('Isaac robotJoints must include every physics joint exactly once')
    names = {path: stage.GetPrimAtPath(path).GetName() for path in paths}
    for path in paths:
        prim = stage.GetPrimAtPath(path)
        if 'IsaacLinkAPI' not in schemas(prim) or not prim.HasAPI(UsdPhysics.RigidBodyAPI) or not prim.HasAPI(UsdPhysics.CollisionAPI):
            raise ValueError('Each robot link needs IsaacLinkAPI, rigid body and collision schemas')
        if not value(prim, 'physics:rigidBodyEnabled', True) or not value(prim, 'physics:collisionEnabled', True) or value(prim, 'physics:kinematicEnabled', False):
            raise ValueError('Robot links require enabled dynamic rigid bodies and collisions')
    connections = []
    cache = UsdGeom.XformCache()
    kinds = {'PhysicsFixedJoint': 'fixed', 'PhysicsRevoluteJoint': 'revolute', 'PhysicsPrismaticJoint': 'prismatic'}
    for path in joints:
        prim = stage.GetPrimAtPath(path)
        if 'IsaacJointAPI' not in schemas(prim) or prim.GetTypeName() not in kinds:
            raise ValueError('Supported robot joints are fixed, revolute and prismatic with IsaacJointAPI')
        joint = UsdPhysics.Joint(prim)
        parents, children = joint.GetBody0Rel().GetTargets(), joint.GetBody1Rel().GetTargets()
        if len(parents) != 1 or len(children) != 1 or parents[0] not in names or children[0] not in names:
            raise ValueError('Joint body0 and body1 must each target one robot link')
        if not joint.GetJointEnabledAttr().Get():
            raise ValueError('Disabled joints cannot describe required physical connections')
        connection = dict(id=prim.GetName(), parent=names[parents[0]], child=names[children[0]], kind=kinds[prim.GetTypeName()])
        frames = []
        for body, position, rotation in [(parents[0], joint.GetLocalPos0Attr().Get(), joint.GetLocalRot0Attr().Get()),
                                         (children[0], joint.GetLocalPos1Attr().Get(), joint.GetLocalRot1Attr().Get())]:
            matrix = cache.GetLocalToWorldTransform(stage.GetPrimAtPath(body))
            if not all(math.isfinite(n) for row in matrix for n in row) or not all(math.isfinite(n) for n in position):
                raise ValueError('Joint frames must be finite')
            quaternion = Gf.Quatd(rotation)
            if not math.isfinite(quaternion.GetLength()) or abs(quaternion.GetLength() - 1) > .00001:
                raise ValueError('Joint frame rotations must be unit quaternions')
            frames.append((matrix.Transform(Gf.Vec3d(position)), matrix, Gf.Rotation(quaternion)))
        if (frames[0][0] - frames[1][0]).GetLength() > .000001:
            raise ValueError('Joint body frames must meet at the saved rest pose')
        if connection['kind'] == 'fixed':
            for axis in [Gf.Vec3d(1,0,0), Gf.Vec3d(0,1,0), Gf.Vec3d(0,0,1)]:
                directions = [matrix.TransformDir(rot.TransformDir(axis)).GetNormalized() for _, matrix, rot in frames]
                if (directions[0] - directions[1]).GetLength() > .00001:
                    raise ValueError('Fixed joint body frame rotations must agree at the saved rest pose')
        if connection['kind'] != 'fixed':
            frame = cache.GetLocalToWorldTransform(stage.GetPrimAtPath(parents[0]))
            local = joint.GetLocalPos0Attr().Get()
            rotation = joint.GetLocalRot0Attr().Get()
            axis_name = value(prim, 'physics:axis', 'X')
            axis = Gf.Vec3d(*{'X': (1,0,0), 'Y': (0,1,0), 'Z': (0,0,1)}[axis_name])
            axes = [matrix.TransformDir(rot.TransformDir(axis)).GetNormalized() for _, matrix, rot in frames]
            if (axes[0] - axes[1]).GetLength() > .00001:
                raise ValueError('Joint body frame axes must agree at the saved rest pose')
            axis = axes[0]
            scale = 1000 if connection['kind'] == 'prismatic' else 1
            connection.update(axis=list(axis), pivot=[n*1000 for n in frame.Transform(Gf.Vec3d(local))],
                              range=[float(value(prim, 'physics:lowerLimit', -math.inf))*scale,
                                     float(value(prim, 'physics:upperLimit', math.inf))*scale])
            if not all(math.isfinite(number) for number in connection['range']):
                raise ValueError('Moving joints require finite lower and upper limits')
            control = value(prim, 'rumi:control')
            if control is not None:
                connection['control'] = control
        connections.append(connection)
    manufacturing = dict(mode=value(root, 'rumi:manufacturingMode', 'print-in-place'))
    steps = value(root, 'rumi:disassembly')
    if steps is not None:
        manufacturing['steps'] = json.loads(steps)
    return dict(assembly=dict(version=1, root=names[paths[0]], parts=[dict(id=names[p], mesh=names[p]) for p in paths],
                             connections=connections, sequences=json.loads(value(root, 'rumi:sequences', '[]')), manufacturing=manufacturing),
                nodes=[dict(name=p.GetName(), mesh=i) for i,p in enumerate(meshes)])


def migrate_assembly(stage, assembly):
    """One-way migration of legacy GLB declarations into standard USD Physics prims."""
    from pxr import Tf
    root = stage.GetDefaultPrim()
    by_name = {prim.GetName(): prim for prim in stage.Traverse() if prim.IsA(UsdGeom.Mesh)}
    links = {part['id']: by_name[Tf.MakeValidIdentifier(part['mesh'])] for part in assembly['parts']}
    ordered = [assembly['root'], *[name for name in links if name != assembly['root']]]
    root.GetRelationship('isaac:physics:robotLinks').SetTargets([links[name].GetPath() for name in ordered])
    joints, renamed = [], {}
    cache = UsdGeom.XformCache()
    for connection in assembly['connections']:
        identifier = Tf.MakeValidIdentifier(connection['id'])
        path = root.GetPath().AppendChild('Joints').AppendChild(identifier)
        if path in joints:
            raise ValueError('Joint names collide after conversion to USD identifiers')
        renamed[connection['id']] = identifier
        joint_type = {'fixed': UsdPhysics.FixedJoint, 'revolute': UsdPhysics.RevoluteJoint, 'prismatic': UsdPhysics.PrismaticJoint}[connection['kind']]
        joint = joint_type.Define(stage, path)
        joint.GetPrim().AddAppliedSchema('IsaacJointAPI')
        parent, child = links[connection['parent']], links[connection['child']]
        joint.CreateBody0Rel().SetTargets([parent.GetPath()])
        joint.CreateBody1Rel().SetTargets([child.GetPath()])
        if connection['kind'] != 'fixed':
            joint.CreateAxisAttr('X')
            pivot = Gf.Vec3d(*[value/1000 for value in connection['pivot']])
            axis = Gf.Vec3d(*connection['axis']).GetNormalized()
            for prim, position_attr, rotation_attr in [(parent, joint.CreateLocalPos0Attr, joint.CreateLocalRot0Attr),
                                                        (child, joint.CreateLocalPos1Attr, joint.CreateLocalRot1Attr)]:
                inverse = cache.GetLocalToWorldTransform(prim).GetInverse()
                position_attr(Gf.Vec3f(inverse.Transform(pivot)))
                local_axis = inverse.TransformDir(axis).GetNormalized()
                rotation_attr(Gf.Quatf(Gf.Rotation(Gf.Vec3d(1,0,0), local_axis).GetQuat()))
            scale = .001 if connection['kind'] == 'prismatic' else 1
            joint.CreateLowerLimitAttr(connection['range'][0]*scale)
            joint.CreateUpperLimitAttr(connection['range'][1]*scale)
            if 'control' in connection:
                joint.GetPrim().CreateAttribute('rumi:control', Sdf.ValueTypeNames.String, custom=False).Set(connection['control'])
        joints.append(path)
    root.GetRelationship('isaac:physics:robotJoints').SetTargets(joints)
    manufacturing = assembly['manufacturing']
    root.GetAttribute('rumi:manufacturingMode').Set(manufacturing['mode'])
    if 'steps' in manufacturing:
        steps = [dict(part=links[step['part']].GetName(), path=step['path']) for step in manufacturing['steps']]
        root.CreateAttribute('rumi:disassembly', Sdf.ValueTypeNames.String, custom=False).Set(json.dumps(steps))
    sequences = [dict(id=item['id'], waypoints=[{renamed[key]: value for key,value in point.items()} for point in item['waypoints']])
                 for item in assembly.get('sequences', [])]
    if sequences:
        root.CreateAttribute('rumi:sequences', Sdf.ValueTypeNames.String, custom=False).Set(json.dumps(sequences))
