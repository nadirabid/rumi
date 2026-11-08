"""Exercise assembly movement and retention through the compiled native protocol."""
import argparse
import copy
import json
from pathlib import Path
import subprocess
import sys
import unittest
sys.dont_write_bytecode = True
from fixtures import request, box, slider, wheel, assembly, two_wheels, loose_pin, loose_cap

parser = argparse.ArgumentParser()
parser.add_argument('executable', type=Path)
args, remaining = parser.parse_known_args()
EXE = args.executable.resolve()


def run(value):
    completed = subprocess.run([str(EXE)], input=json.dumps(value), capture_output=True, text=True, timeout=240)
    return completed.returncode, json.loads(completed.stdout)


class NativeTests(unittest.TestCase):
    def assert_verified(self, value):
        code, result = run(value)
        self.assertEqual(code,0,result)
        self.assertEqual(result['status'],'passed',result)
        self.assertTrue(result['assemblyVerified'],result)
        self.assertTrue(result['coverage']['complete'])
        self.assertEqual(set(result['coverage']['connections']), {c['id'] for c in value['assembly']['connections']})
        self.assertEqual(result['policy'],value['settings'])
        return result

    def test_single_solid_static_part(self):
        self.assert_verified(assembly([box('part',[0,0,0],[2,2,2])],'part',[]))

    def test_single_declared_part_cannot_hide_disconnected_solids(self):
        first=box('part',[0,0,0],[2,2,2]);second=box('other',[10,0,0],[2,2,2]);offset=len(first['vertices'])
        first['vertices'].extend(second['vertices']);first['triangles'].extend([[i+offset for i in f] for f in second['triangles']])
        code,result=run(assembly([first],'part',[]))
        self.assertEqual(code,0,result);self.assertEqual(result['status'],'needs_repair');self.assertFalse(result['assemblyVerified'])

    def test_actual_collision_smoke(self):
        completed=subprocess.run([str(EXE),'--self-test'],capture_output=True,text=True,timeout=30,check=True)
        self.assertTrue(json.loads(completed.stdout)['ok'])
        self.assertEqual(json.loads(completed.stdout)['protocolVersion'],2)

    def test_retains_and_moves_connected_hinge(self):
        value=request()
        # Frictionless cone contact needs finer steps to remain within the 0.05 mm penetration limit.
        value['settings']['timeStepSeconds']=.000125
        result=self.assert_verified(value)
        probes=result['connections'][0]['probes']
        self.assertTrue(any(p['kind']=='movement' and abs(p['actual']['hinge']+90)<3 for p in probes))
        self.assertTrue(any(p['kind']=='movement' and abs(p['actual']['hinge']+45)<3 for p in probes))

    def test_detects_missing_connector(self):
        code,result=run(request(True))
        self.assertEqual(code,0,result)
        self.assertEqual(result['status'],'needs_repair',result)
        self.assertIn('unretained_part',[c['code'] for c in result['checks']])
        self.assertFalse(result['assemblyVerified'])

    def test_translated_geometry_preserves_missing_connector(self):
        value=request(True);shift=[10000,-20000,30000]
        for b in value['bodies']:b['vertices']=[[p[i]+shift[i] for i in range(3)] for p in b['vertices']]
        value['assembly']['connections'][0]['pivot']=[shift[0],shift[1],shift[2]+.25]
        code,result=run(value)
        self.assertEqual(code,0,result)
        self.assertEqual(result['checks'][0]['code'],'unretained_part')

    def test_disconnected_mesh_cannot_be_one_physical_part(self):
        value=request();moving=value['bodies'][1];detached=box('detached',[50,0,0],[1,1,1]);offset=len(moving['vertices'])
        moving['vertices'].extend(detached['vertices']);moving['triangles'].extend([[i+offset for i in f] for f in detached['triangles']])
        code,result=run(value)
        self.assertEqual(code,0,result)
        self.assertEqual(result['checks'][0]['code'],'disconnected_body')
        self.assertFalse(result['coverage']['complete'])

    def test_retains_and_moves_prismatic_slider(self):
        self.assert_verified(slider())

    def test_detects_interfering_slider(self):
        code,result=run(slider(True))
        self.assertEqual(code,0,result)
        self.assertEqual(result['status'],'needs_repair',result)

    def test_captive_wheel_moves_through_both_half_turns(self):
        result=self.assert_verified(wheel())
        positions=[p['actual']['wheel'] for p in result['connections'][0]['probes'] if p['kind']=='movement']
        self.assertTrue(any(abs(v-180)<3 for v in positions));self.assertTrue(any(abs(v+180)<3 for v in positions))

    def test_complete_assembly_with_two_dynamic_wheels(self):
        value=two_wheels()
        value['assembly']['sequences']=[dict(id='both',waypoints=[dict(lower=45,upper=-45),dict(lower=0,upper=0)])]
        result=self.assert_verified(value)
        self.assertEqual(result['coverage']['sequences'],['both'])

    def test_captive_wheel_under_production_gravity_and_friction(self):
        value=wheel();value['settings'].update(gravityMps2=[0,0,-9.81],friction=.2,movementSampleDegrees=15)
        self.assert_verified(value)

    def test_loose_pin_cannot_be_frozen_as_support(self):
        code,result=run(loose_pin())
        self.assertEqual(code,0,result);self.assertEqual(result['status'],'needs_repair',result)
        self.assertEqual(result['checks'][0]['connection'],'pin_mount')

    def test_loose_cap_cannot_retain_the_wheel(self):
        code,result=run(loose_cap())
        self.assertEqual(code,0,result);self.assertEqual(result['status'],'needs_repair',result)
        self.assertIn(result['checks'][0]['connection'],['wheel','cap_mount'])

    def test_separated_fixed_parts_fail_retention(self):
        value=assembly([box('root',[0,0,0],[2,2,2]),box('loose',[10,0,0],[1,1,1])],'root',[dict(id='attachment',parent='root',child='loose',kind='fixed')])
        code,result=run(value)
        self.assertEqual(code,0,result);self.assertEqual(result['checks'][0]['code'],'unretained_part')

    def test_separate_parts_without_assembly_path_remain_unverified(self):
        value=wheel();value['assembly']['manufacturing']['mode']='separate'
        code,result=run(value)
        self.assertEqual(code,0,result);self.assertEqual(result['status'],'review',result)
        self.assertFalse(result['assemblyVerified']);self.assertIn('assembly_route_unverified',[c['code'] for c in result['checks']])

    def test_separate_slider_has_sampled_removal_route(self):
        value=slider();value['assembly']['manufacturing']=dict(mode='separate',steps=[dict(part='moving',path=[[0,0,0],[20,0,0]])])
        result=self.assert_verified(value)
        self.assertEqual(result['coverage']['assemblySteps'],['moving'])

    def test_removal_path_cannot_cross_the_frame(self):
        value=slider();value['assembly']['manufacturing']=dict(mode='separate',steps=[dict(part='moving',path=[[0,0,0],[0,20,0]])])
        code,result=run(value)
        self.assertEqual(code,0,result);self.assertEqual(result['status'],'needs_repair',result)
        self.assertIn('assembly_path_interference',[c['code'] for c in result['checks']])
        self.assertFalse(result['coverage']['complete'])

    def test_excessive_sequence_work_is_unverified_without_partial_pass(self):
        value=wheel();value['assembly']['sequences']=[dict(id=str(i),waypoints=[dict(wheel=0) for _ in range(64)]) for i in range(4)]
        code,result=run(value)
        self.assertEqual(code,0,result);self.assertEqual(result['status'],'review');self.assertFalse(result['coverage']['complete'])
        self.assertEqual(result['checks'][0]['code'],'probe_budget_exhausted')

    def test_large_work_plan_still_detects_a_loose_baseline_part(self):
        value=loose_pin();value['assembly']['sequences']=[dict(id=str(i),waypoints=[dict(wheel=0) for _ in range(64)]) for i in range(4)]
        code,result=run(value)
        self.assertEqual(code,0,result);self.assertEqual(result['status'],'needs_repair',result)
        self.assertFalse(result['coverage']['complete']);self.assertFalse(result['assemblyVerified'])
        codes=[c['code'] for c in result['checks']]
        self.assertIn('probe_budget_exhausted',codes);self.assertIn('unretained_part',codes)
        self.assertTrue(any(p['kind']=='retention' for c in result['connections'] for p in c['probes']))

    def test_closed_loop_is_not_reported_as_verified(self):
        value=wheel();value['assembly']['connections'].append(dict(id='loop',parent='wheel',child='axle',kind='fixed'))
        code,result=run(value)
        self.assertEqual(code,0,result);self.assertEqual(result['status'],'review',result)
        self.assertFalse(result['assemblyVerified']);self.assertEqual(len(result['connections']),2)

    def test_inadequate_probe_load_remains_unverified(self):
        value=request(True);value['settings']['forceN']=.000001
        code,result=run(value)
        self.assertEqual(code,0,result);self.assertEqual(result['status'],'review',result)
        self.assertEqual(result['checks'][0]['code'],'probe_inconclusive')

    def test_simulation_policy_rejects_out_of_bounds_settings(self):
        for name,setting in [('gravityMps2',[0,0,-21]),('friction',1.01),('movementSampleMm',.01),('assemblySampleMm',3)]:
            value=assembly([box('part',[0,0,0],[2,2,2])],'part',[]);value['settings'][name]=setting
            code,result=run(value)
            self.assertEqual(code,2,result);self.assertEqual(result['error']['code'],'invalid_request')

    def test_legacy_protocol_cannot_pass(self):
        value=request();value['version']=1
        code,result=run(value)
        self.assertEqual(code,2,result);self.assertEqual(result['error']['code'],'invalid_request')

    def test_invalid_triangle_index_is_structured_failure(self):
        value=request();value['bodies'][0]['triangles'][0][0]=-1
        code,result=run(value)
        self.assertEqual(code,2,result);self.assertEqual(result['error']['code'],'invalid_request')


if __name__=='__main__':unittest.main(argv=['native.py',*remaining],verbosity=2)
