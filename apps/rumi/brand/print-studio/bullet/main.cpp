// Bounded rigid-part probes. Connections are supplied only by triangle geometry.
#include <btBulletDynamicsCommon.h>
#include <BulletCollision/Gimpact/btGImpactCollisionAlgorithm.h>
#include <BulletCollision/Gimpact/btGImpactShape.h>
#include <nlohmann/json.hpp>
#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <iostream>
#include <future>
#include <map>
#include <memory>
#include <numeric>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

using Json = nlohmann::json;
using Clock = std::chrono::steady_clock;
constexpr double pi = 3.14159265358979323846;
constexpr std::size_t maxInputBytes = 64 * 1024 * 1024;
constexpr std::size_t maxTriangles = 200000;
constexpr std::size_t maxVertices = 600000;
constexpr int maxBodies = 128;

struct Invalid : std::runtime_error { using std::runtime_error::runtime_error; };
double number(const Json& object, const std::string& key, double low, double high) {
    if (!object.contains(key) || !object.at(key).is_number()) throw Invalid(key + " must be a number");
    double value = object.at(key).get<double>();
    if (!std::isfinite(value) || value < low || value > high) throw Invalid(key + " is outside supported bounds");
    return value;
}
std::string text(const Json& object, const std::string& key) {
    if (!object.contains(key) || !object.at(key).is_string()) throw Invalid(key + " must be a string");
    auto value = object.at(key).get<std::string>();
    if (value.empty() || value.size() > 200) throw Invalid(key + " must contain 1 to 200 bytes");
    return value;
}
btVector3 vector(const Json& value, double scale = 1) {
    if (!value.is_array() || value.size() != 3) throw Invalid("Expected a three-coordinate vector");
    btVector3 result;
    for (int i = 0; i < 3; ++i) {
        if (!value[i].is_number()) throw Invalid("Vector coordinates must be numbers");
        double coordinate = value[i].get<double>();
        if (!std::isfinite(coordinate) || std::abs(coordinate) > 1000000) throw Invalid("Vector coordinate is outside supported bounds");
        result[i] = coordinate * scale;
    }
    return result;
}
Json coordinates(const btVector3& value, double scale = 1) { return {value.x()*scale, value.y()*scale, value.z()*scale}; }
struct Settings {
    double dt, duration, restDuration, retentionDuration, density, force, torque, linearTolerance, angularTolerance, penetration;
    int iterations, maxTotalSteps, retentionWorkers;
    btVector3 gravity;
    double friction,movementDegrees,movementMm,assemblyMm;
};
Settings settings(const Json& value) {
    Settings s;
    s.dt = number(value,"timeStepSeconds",.00005,.002);
    s.duration = number(value,"probeDurationSeconds",.05,2);
    s.restDuration = number(value,"restDurationSeconds",.005,.2);
    s.retentionDuration = number(value,"retentionDurationSeconds",.01,.5);
    s.density = number(value,"densityKgM3",100,20000);
    s.force = number(value,"forceN",.000001,100);
    s.torque = number(value,"torqueNm",.000000001,10);
    s.linearTolerance = number(value,"linearToleranceMm",.001,5)*.001;
    s.angularTolerance = number(value,"angularToleranceDegrees",.1,15)*pi/180;
    s.penetration = number(value,"maxPenetrationMm",.001,1)*.001;
    double iterations = number(value,"iterations",4,200);
    if (std::floor(iterations) != iterations) throw Invalid("iterations must be an integer");
    s.iterations = int(iterations);
    double allowance = number(value,"maxTotalSteps",1000,10000000);
    double workers = number(value,"retentionWorkers",1,4);
    if (std::floor(allowance) != allowance || std::floor(workers) != workers) throw Invalid("Step allowance and worker count must be integers");
    s.maxTotalSteps = int(allowance);
    s.retentionWorkers = int(workers);
    s.gravity=vector(value.at("gravityMps2"));
    for(int i=0;i<3;++i)if(std::abs(s.gravity[i])>20)throw Invalid("Gravity components must be within 20 m/s2");
    s.friction=number(value,"friction",0,1);
    s.movementDegrees=number(value,"movementSampleDegrees",1,90);
    s.movementMm=number(value,"movementSampleMm",.1,10);
    s.assemblyMm=number(value,"assemblySampleMm",.01,2);
    return s;
}
struct Body {
    std::string id, topology;
    std::vector<btVector3> vertices;
    std::vector<std::array<int,3>> triangles;
    btVector3 com, moments;
    btMatrix3x3 basis, inertia;
    double mass = 0;
    std::unique_ptr<btTriangleMesh> mesh;
    std::unique_ptr<btGImpactMeshShape> shape;
};
// GImpact updates shape caches during collision detection; workers never share them.
void buildShape(Body& b) {
    b.mesh=std::make_unique<btTriangleMesh>(true,false);
    for(auto triangle:b.triangles) {
        btVector3 points[3]; for(int i=0;i<3;++i) points[i]=b.basis.transpose()*(b.vertices[triangle[i]]-b.com);
        b.mesh->addTriangle(points[0],points[1],points[2],false);
    }
    b.shape=std::make_unique<btGImpactMeshShape>(b.mesh.get()); b.shape->setMargin(0); b.shape->updateBound();
}
std::vector<Body> cloneBodies(const std::vector<Body>& source) {
    std::vector<Body> result;
    for (const auto& b : source) {
        Body copy;
        copy.id=b.id; copy.vertices=b.vertices; copy.triangles=b.triangles;
        copy.com=b.com; copy.moments=b.moments; copy.basis=b.basis; copy.inertia=b.inertia; copy.mass=b.mass;
        buildShape(copy);
        result.push_back(std::move(copy));
    }
    return result;
}
int root(std::vector<int>& groups, int i) {
    while (groups[i] != i) { groups[i] = groups[groups[i]]; i = groups[i]; }
    return i;
}
Body body(const Json& value, const Settings& s, std::size_t& totalTriangles, std::size_t& totalVertices, bool fixed = false) {
    Body b; b.id = text(value,"id");
    if (!value.contains("vertices") || !value.at("vertices").is_array() || !value.contains("triangles") || !value.at("triangles").is_array()) throw Invalid("Body requires vertices and triangles arrays");
    totalVertices += value.at("vertices").size(); totalTriangles += value.at("triangles").size();
    if (totalVertices > maxVertices || totalTriangles > maxTriangles || value.at("vertices").size() < 4 || value.at("triangles").size() < 4) throw Invalid("Assembly geometry exceeds supported limits");
    std::map<std::array<double,3>,int> unique;
    std::vector<int> canonical;
    for (const auto& point : value.at("vertices")) {
        auto v = vector(point,.001);
        std::array<double,3> key{v.x(),v.y(),v.z()};
        auto [entry, added] = unique.emplace(key,int(unique.size()));
        canonical.push_back(entry->second);
        b.vertices.push_back(v);
    }
    std::vector<int> groups(value.at("triangles").size()); std::iota(groups.begin(),groups.end(),0);
    struct Edge { int count=0, orientation=0, firstFace=0; };
    std::map<std::pair<int,int>,Edge> edges;
    // Signed tetrahedra use a nearby origin so scene placement does not cancel small moments.
    btVector3 reference=b.vertices.front();
    double volume = 0; btVector3 first(0,0,0); btMatrix3x3 second(0,0,0,0,0,0,0,0,0);
    for (const auto& face : value.at("triangles")) {
        if (!face.is_array() || face.size() != 3) throw Invalid("Each triangle must contain three indices");
        std::array<int,3> indices;
        for (int i=0;i<3;++i) {
            if (!face[i].is_number_integer()) throw Invalid("Triangle indices must be integers");
            auto index=face[i].get<std::int64_t>();
            if (index<0 || index>=std::int64_t(b.vertices.size())) throw Invalid("Triangle index is outside its vertex array");
            indices[i]=int(index);
        }
        auto a=b.vertices[indices[0]]-reference, c=b.vertices[indices[1]]-reference, d=b.vertices[indices[2]]-reference;
        if ((c-a).cross(d-a).length2()<1e-30) b.topology="degenerate_body";
        int faceIndex=int(b.triangles.size());
        for (int i=0;i<3;++i) {
            int x=canonical[indices[i]], y=canonical[indices[(i+1)%3]];
            auto& edge=edges[{std::min(x,y),std::max(x,y)}];
            if(edge.count==0) edge.firstFace=faceIndex;
            else groups[root(groups,faceIndex)]=root(groups,edge.firstFace);
            ++edge.count; edge.orientation += x<y?1:-1;
        }
        double v=a.dot(c.cross(d))/6;
        volume+=v; first+=(a+c+d)*(v/4);
        for (int i=0;i<3;++i) for(int j=0;j<3;++j) second[i][j]+=v/20*((a[i]+c[i]+d[i])*(a[j]+c[j]+d[j])+a[i]*a[j]+c[i]*c[j]+d[i]*d[j]);
        b.triangles.push_back(indices);
    }
    for (auto& [key,value] : edges) if(value.count!=2 || value.orientation!=0) b.topology="non_manifold_body";
    // A shared vertex has no material cross-section and cannot make two shells one rigid part.
    std::set<int> components; for(std::size_t i=0;i<b.triangles.size();++i) components.insert(root(groups,int(i)));
    if(components.size()!=1 && b.topology.empty()) {
        std::map<int,double> componentVolumes;
        for(std::size_t i=0;i<b.triangles.size();++i) {
            auto triangle=b.triangles[i];
            componentVolumes[root(groups,int(i))]+=(b.vertices[triangle[0]]-reference).dot((b.vertices[triangle[1]]-reference).cross(b.vertices[triangle[2]]-reference))/6;
        }
        int positive=0; for(auto [component,v]:componentVolumes) if(v>1e-15) ++positive;
        b.topology=positive>1?"disconnected_body":"unsupported_body_topology";
    }
    if (!(volume>1e-15) || !std::isfinite(volume)) b.topology="invalid_body_volume";
    if (!b.topology.empty()) return b;
    btVector3 localCom=first/volume; b.com=reference+localCom; b.mass=volume*s.density;
    double trace=second[0][0]+second[1][1]+second[2][2];
    for(int i=0;i<3;++i) for(int j=0;j<3;++j) b.inertia[i][j]=s.density*((i==j?trace:0)-second[i][j])-b.mass*((i==j?localCom.length2():0)-localCom[i]*localCom[j]);
    btMatrix3x3 diagonal=b.inertia; diagonal.diagonalize(b.basis,1e-12,64);
    b.moments=btVector3(diagonal[0][0],diagonal[1][1],diagonal[2][2]);
    if (!std::isfinite(b.mass) || b.mass<=0 || b.mass>1000) throw Invalid("Invalid body mass");
    for(int i=0;i<3;++i) if(!std::isfinite(b.moments[i]) || b.moments[i]<=1e-18) b.topology="invalid_body_inertia";
    if(!b.topology.empty()) return b;
    // The fixed root needs no inertia frame; keep its contact tree aligned with the exported geometry.
    if (fixed) b.basis.setIdentity();
    buildShape(b);
    return b;
}
struct Connection {
    std::string id,kind,parentId,childId;
    std::size_t parent,child;
    btVector3 axis{0,0,1},parentPivot{0,0,0},childPivot{0,0,0};
    btVector3 transverse, binormal;
    btMatrix3x3 restRotation;
    double low=0,high=0;
};
struct State { std::vector<btTransform> transforms; std::vector<btVector3> linear,angular; std::vector<double> angles; };
struct World {
    btDefaultCollisionConfiguration configuration;
    btCollisionDispatcher dispatcher{&configuration};
    btDbvtBroadphase broadphase;
    btSequentialImpulseConstraintSolver solver;
    btDiscreteDynamicsWorld world{&dispatcher,&broadphase,&solver,&configuration};
    std::vector<std::unique_ptr<btRigidBody>> bodies;
    std::set<std::size_t> removed;
    World(std::vector<Body>& definitions,std::size_t fixture,const Settings& s,const State* initial=nullptr) {
        btGImpactCollisionAlgorithm::registerAlgorithm(&dispatcher);
        world.setGravity(s.gravity);
        world.getSolverInfo().m_numIterations=s.iterations;
        world.getSolverInfo().m_splitImpulse=true;
        world.getSolverInfo().m_splitImpulsePenetrationThreshold=0;
        for(std::size_t i=0;i<definitions.size();++i) {
            auto& part = definitions[i];
            bool fixed = i == fixture;
            btRigidBody::btRigidBodyConstructionInfo info(
                fixed ? 0 : part.mass, nullptr, part.shape.get(), fixed ? btVector3(0, 0, 0) : part.moments);
            info.m_friction=s.friction; info.m_restitution=0; info.m_linearDamping=0; info.m_angularDamping=0;
            auto object=std::make_unique<btRigidBody>(info);
            object->setCenterOfMassTransform(initial?initial->transforms[i]:btTransform(part.basis,part.com));
            if(initial && !fixed) {object->setLinearVelocity(initial->linear[i]);object->setAngularVelocity(initial->angular[i]);}
            object->setActivationState(DISABLE_DEACTIVATION); object->setSleepingThresholds(0,0);
            world.addRigidBody(object.get()); bodies.push_back(std::move(object));
        }
    }
    ~World() {for(std::size_t i=0;i<bodies.size();++i)if(!removed.count(i))world.removeRigidBody(bodies[i].get());}
    double penetration() {
        double depth=0;
        for(int i=0;i<dispatcher.getNumManifolds();++i) {
            auto* m=dispatcher.getManifoldByIndexInternal(i);
            for(int j=0;j<m->getNumContacts();++j)depth=std::max(depth,-double(m->getContactPoint(j).getDistance()));
        }
        return depth;
    }
    State snapshot(const std::vector<double>& angles) {
        State state;state.angles=angles;
        for(auto& b:bodies) {state.transforms.push_back(b->getCenterOfMassTransform());state.linear.push_back(b->getLinearVelocity());state.angular.push_back(b->getAngularVelocity());}
        return state;
    }
};
struct Measurement {double position,angle,drift,offAxis,principal;};
Measurement measure(World& w,const Connection& c,double previousAngle) {
    auto parent=w.bodies[c.parent]->getCenterOfMassTransform(),child=w.bodies[c.child]->getCenterOfMassTransform();
    auto rotation=parent.getBasis().transpose()*child.getBasis()*c.restRotation.transpose();
    btQuaternion q;rotation.getRotation(q);q.normalize();
    double principal=2*std::atan2(btVector3(q.x(),q.y(),q.z()).dot(c.axis),q.w());
    double angle=previousAngle+std::remainder(principal-previousAngle,2*pi);
    auto shift=parent.inverse()*(child*c.childPivot)-c.parentPivot;
    double position=shift.dot(c.axis);
    double drift=c.kind=="prismatic"?(shift-c.axis*position).length():shift.length();
    double offAxis=c.kind=="revolute"?std::acos(std::clamp(double((rotation*c.axis).dot(c.axis)),-1.,1.)):2*std::acos(std::clamp(std::abs(double(q.w())),0.,1.));
    if(!std::isfinite(angle)||!std::isfinite(position)||!std::isfinite(drift)||!std::isfinite(offAxis))throw std::runtime_error("Bullet returned nonfinite state");
    return {position,angle,drift,offAxis,principal};
}
struct Trial {Json result;State finalState;};
// Loads exercise contacts. The declared connections are observed, never added to Bullet as constraints.
Trial trial(std::vector<Body>& definitions,std::size_t fixture,const std::vector<Connection>& connections,const Settings& s,
            const State* initial,const std::map<std::size_t,double>& targets,std::size_t loaded,btVector3 force,btVector3 torque,
            const std::string& kind,double duration,int& budget) {
    int steps=int(std::ceil(duration/s.dt));
    if(budget+steps>s.maxTotalSteps)return {{{"kind",kind},{"status","review"},{"code","probe_budget_exhausted"}},State{}};
    budget+=steps;
    World w(definitions,fixture,s,initial);
    std::vector<double> angles=initial?initial->angles:std::vector<double>(connections.size(),0);
    double maxDrift=0,maxOffAxis=0,maxDepth=0,maxForce=force.length(),maxTorque=torque.length();
    std::string failure,failedConnection;
    std::map<std::size_t,double> integratedErrors;
    w.world.performDiscreteCollisionDetection();maxDepth=w.penetration();
    if(maxDepth>s.penetration)failure="initial_interference";
    int completed=0;
    for(int step=0;step<steps && failure.empty();++step) {
        if(loaded<connections.size()) {
            const auto& c=connections[loaded];auto orientation=w.bodies[c.parent]->getCenterOfMassTransform().getBasis();
            auto f=orientation*force,t=orientation*torque;
            w.bodies[c.child]->applyCentralForce(f);w.bodies[c.parent]->applyCentralForce(-f);
            w.bodies[c.child]->applyTorque(t);w.bodies[c.parent]->applyTorque(-t);
        }
        for(auto [index,target]:targets) {
            const auto& c=connections[index];auto* child=w.bodies[c.child].get();auto* parent=w.bodies[c.parent].get();
            auto axis=parent->getCenterOfMassTransform().getBasis()*c.axis;
            auto current=measure(w,c,angles[index]);double frequency=10/duration;
            if(c.kind=="revolute") {
                auto effectiveInertia=[&](std::size_t bodyIndex,const btVector3& localPivot) {
                    if(bodyIndex==fixture)return 0.;
                    auto* b=w.bodies[bodyIndex].get();auto transform=b->getCenterOfMassTransform();
                    auto pivotOffset=transform.getBasis()*localPivot;const auto& part=definitions[bodyIndex];
                    auto localAxis=transform.getBasis().transpose()*axis;
                    double inertia=localAxis.x()*localAxis.x()*part.moments.x()+localAxis.y()*localAxis.y()*part.moments.y()+localAxis.z()*localAxis.z()*part.moments.z();
                    inertia+=part.mass*(pivotOffset.length2()-std::pow(pivotOffset.dot(axis),2));
                    return 1/inertia;
                };
                double inertia=1/(effectiveInertia(c.child,c.childPivot)+effectiveInertia(c.parent,c.parentPivot));
                double speed=(child->getAngularVelocity()-parent->getAngularVelocity()).dot(axis);
                double error=target-current.angle;integratedErrors[index]+=error*s.dt;
                double amount=std::clamp(inertia*(3*frequency*frequency*error-3*frequency*speed+frequency*frequency*frequency*integratedErrors[index]),-s.torque,s.torque);
                child->applyTorque(axis*amount);parent->applyTorque(axis*-amount);maxTorque=std::max(maxTorque,std::abs(amount));
            } else {
                double mass=1/(child->getInvMass()+parent->getInvMass());
                double speed=(child->getLinearVelocity()-parent->getLinearVelocity()).dot(axis);
                double error=target-current.position;integratedErrors[index]+=error*s.dt;
                double amount=std::clamp(mass*(3*frequency*frequency*error-3*frequency*speed+frequency*frequency*frequency*integratedErrors[index]),-s.force,s.force);
                child->applyCentralForce(axis*amount);parent->applyCentralForce(axis*-amount);maxForce=std::max(maxForce,std::abs(amount));
            }
        }
        w.world.stepSimulation(s.dt,0,s.dt);completed=step+1;
        maxDepth=std::max(maxDepth,w.penetration());
        if(!std::isfinite(maxDepth))throw std::runtime_error("Bullet returned nonfinite contact depth");
        if(maxDepth>s.penetration)failure="excessive_penetration";
        for(std::size_t i=0;i<connections.size();++i) {
            const auto& c=connections[i];auto m=measure(w,c,angles[i]);angles[i]=m.angle;
            maxDrift=std::max(maxDrift,m.drift);maxOffAxis=std::max(maxOffAxis,m.offAxis);
            if(failure.empty() && (m.drift>s.linearTolerance || m.offAxis>s.angularTolerance)) {
                failure=kind=="rest"?"unstable_at_rest":"unretained_part";failedConnection=c.id;
            }
        }
    }
    Json actual=Json::object();
    for(auto [index,target]:targets) {
        const auto& c=connections[index];auto m=measure(w,c,angles[index]);double value=c.kind=="revolute"?m.angle:m.position;
        actual[c.id]=value*(c.kind=="revolute"?180/pi:1000);
        double tolerance=c.kind=="revolute"?s.angularTolerance:s.linearTolerance;
        if(failure.empty() && std::abs(value-target)>tolerance) {failure="movement_blocked";failedConnection=c.id;}
    }
    Json result{{"kind",kind},{"status",failure.empty()?"passed":"needs_repair"},{"code",failure.empty()?"probe_passed":failure},
      {"durationSeconds",completed*s.dt},{"actual",actual},{"maxPivotDriftMm",maxDrift*1000},{"maxOffAxisDegrees",maxOffAxis*180/pi},
      {"maxPenetrationMm",maxDepth*1000},{"maxForceN",maxForce},{"maxTorqueNm",maxTorque}};
    if(!failedConnection.empty())result["connection"]=failedConnection;
    return {result,w.snapshot(angles)};
}
struct RouteResult {std::string status,code;Json steps,details;};
// Sampled reverse-disassembly checks preserve the order of removed physical pieces.
RouteResult assemblyRoute(std::vector<Body>& definitions,std::size_t fixture,const Json& manufacturing,const Settings& s,int& budget) {
    if(!manufacturing.contains("steps"))return {"review","assembly_route_unverified",Json::array(),{{"reason","missing_disassembly_steps"}}};
    const auto& steps=manufacturing.at("steps");
    if(!steps.is_array() || steps.size()!=definitions.size()-1)throw Invalid("Disassembly steps must cover every nonroot part once");
    std::map<std::string,std::size_t> names;for(std::size_t i=0;i<definitions.size();++i)names[definitions[i].id]=i;
    std::set<std::size_t> removed;Json complete=Json::array();World world(definitions,fixture,s);
    for(const auto& step:steps) {
        auto id=text(step,"part");if(!names.count(id)||names.at(id)==fixture||removed.count(names.at(id)))throw Invalid("Disassembly part must be a unique nonroot part");
        auto selected=names.at(id);const auto& path=step.at("path");
        if(!path.is_array()||path.size()<2||path.size()>256)throw Invalid("Disassembly path needs 2 to 256 offsets");
        btVector3 previous=vector(path[0],.001);if(previous.length2()>1e-20)throw Invalid("Disassembly offsets must start at zero");
        auto* moving=world.bodies[selected].get();auto rest=moving->getCenterOfMassTransform();
        for(std::size_t i=1;i<path.size();++i) {
            auto target=vector(path[i],.001);double length=(target-previous).length();int samples=int(std::ceil(length/(s.assemblyMm*.001)));samples=std::max(1,samples);
            if(samples>s.maxTotalSteps-budget)return {"review","probe_budget_exhausted",complete,{{"part",id},{"phase","assembly_route"}}};
            budget+=samples;
            for(int n=0;n<=samples;++n) {
                auto pose=rest;pose.setOrigin(rest.getOrigin()+previous+(target-previous)*double(n)/samples);moving->setCenterOfMassTransform(pose);world.world.updateSingleAabb(moving);
                world.world.performDiscreteCollisionDetection();double depth=world.penetration();
                if(depth>s.penetration)return {"needs_repair","assembly_path_interference",complete,{{"part",id},{"segment",i-1},{"maxPenetrationMm",depth*1000}}};
            }
            previous=target;
        }
        btVector3 low,high;moving->getAabb(low,high);
        for(std::size_t i=0;i<definitions.size();++i)if(i!=selected&&!removed.count(i)) {
            btVector3 otherLow,otherHigh;world.bodies[i]->getAabb(otherLow,otherHigh);bool overlaps=true;
            for(int axis=0;axis<3;++axis)overlaps &= low[axis]<=otherHigh[axis] && high[axis]>=otherLow[axis];
            if(overlaps)return {"review","assembly_route_unverified",complete,{{"part",id},{"reason","endpoint_not_clear_of_remaining_parts"}}};
        }
        world.world.removeRigidBody(moving);world.removed.insert(selected);removed.insert(selected);complete.push_back(id);
    }
    return {"passed","assembly_route_sampled",complete,{{"sampleSpacingMm",s.assemblyMm},{"scope","translation_only_reverse_disassembly"}}};
}
Json evaluate(const Json& request) {
    if(!request.is_object() || request.value("version",0)!=2)throw Invalid("Expected assembly protocol version 2");
    Settings s=settings(request.at("settings"));
    const auto& a=request.at("assembly");
    if(!a.is_object() || a.value("version",0)!=1)throw Invalid("Expected assembly version 1");
    if(!request.at("bodies").is_array() || request.at("bodies").empty() || request.at("bodies").size()>maxBodies)throw Invalid("Expected 1 to 128 physical bodies");
    if(!a.at("parts").is_array() || a.at("parts").size()!=request.at("bodies").size())throw Invalid("Assembly must map every physical body");
    if(!a.at("connections").is_array() || a.at("connections").size()>128)throw Invalid("Expected at most 128 connections");
    std::vector<Body> bodies;std::map<std::string,std::size_t> names;std::size_t triangles=0,vertices=0;
    for(const auto& input:request.at("bodies")) {
        Body b=body(input,s,triangles,vertices,text(input,"id")==text(a,"root"));
        if(!names.emplace(b.id,bodies.size()).second)throw Invalid("Body ids must be unique");
        bodies.push_back(std::move(b));
    }
    std::set<std::string> parts,meshes;
    for(const auto& p:a.at("parts"))if(!parts.insert(text(p,"id")).second || !meshes.insert(text(p,"mesh")).second || !names.count(text(p,"id")))throw Invalid("Every part needs a unique physical mesh and body id");
    auto rootId=text(a,"root");if(!names.count(rootId))throw Invalid("Assembly root must name a part");auto fixture=names.at(rootId);
    std::vector<Connection> connections;std::map<std::string,std::size_t> ids;std::vector<int> parents(bodies.size(),0);
    std::vector<std::vector<std::size_t>> children(bodies.size());
    for(const auto& input:a.at("connections")) {
        Connection c;c.id=text(input,"id");c.kind=text(input,"kind");c.parentId=text(input,"parent");c.childId=text(input,"child");
        if(!names.count(c.parentId)||!names.count(c.childId)||c.parentId==c.childId||!ids.emplace(c.id,connections.size()).second)throw Invalid("Connection endpoints and ids must be valid and unique");
        c.parent=names.at(c.parentId);c.child=names.at(c.childId);parents[c.child]++;children[c.parent].push_back(c.child);
        if(c.kind!="fixed"&&c.kind!="revolute"&&c.kind!="prismatic")throw Invalid("Unsupported rigid connection kind");
        auto parent=btTransform(bodies[c.parent].basis,bodies[c.parent].com),child=btTransform(bodies[c.child].basis,bodies[c.child].com);
        btVector3 pivot=bodies[c.child].com;
        btVector3 worldAxis(0, 0, 1);
        if(c.kind!="fixed") {
            worldAxis=vector(input.at("axis"));if(worldAxis.length()<1e-6)throw Invalid("Connection axis must be nonzero");worldAxis.normalize();
            pivot=vector(input.at("pivot"),.001);auto range=input.at("range");if(!range.is_array()||range.size()!=2)throw Invalid("Connection range needs two bounds");
            Json limits{{"low",range[0]},{"high",range[1]}};double limit=c.kind=="revolute"?180:1000,scale=c.kind=="revolute"?pi/180:.001;
            c.low=number(limits,"low",-limit,0)*scale;c.high=number(limits,"high",0,limit)*scale;if(c.low==c.high)throw Invalid("Connection range must include movement");
        }
        // Probe directions belong to the declared rest-world frame, independent of inertia eigenvectors.
        auto inverseParent = parent.getBasis().transpose();
        btVector3 seed = std::abs(worldAxis.x()) < .8 ? btVector3(1, 0, 0) : btVector3(0, 1, 0);
        auto transverse = worldAxis.cross(seed).normalized();
        c.axis = inverseParent * worldAxis;
        c.transverse = inverseParent * transverse;
        c.binormal = inverseParent * worldAxis.cross(transverse).normalized();
        c.parentPivot=parent.inverse()*pivot;c.childPivot=child.inverse()*pivot;c.restRotation=parent.getBasis().transpose()*child.getBasis();connections.push_back(c);
    }
    std::set<std::size_t> reached;std::vector<std::size_t> pending{fixture};
    while(!pending.empty()) {auto i=pending.back();pending.pop_back();if(!reached.insert(i).second)continue;for(auto c:children[i])pending.push_back(c);}
    if(reached.size()!=bodies.size())throw Invalid("Every part needs a connection path from root");
    std::string mode=text(a.at("manufacturing"),"mode");if(mode!="print-in-place"&&mode!="separate")throw Invalid("Unsupported manufacturing mode");
    std::vector<std::pair<std::string,std::vector<std::map<std::size_t,double>>>> sequences;
    if(a.contains("sequences")) {
        if(!a.at("sequences").is_array()||a.at("sequences").size()>32)throw Invalid("Expected at most 32 sequences");
        std::set<std::string> sequenceIds;int total=0;
        for(const auto& sequence:a.at("sequences")) {
            auto id=text(sequence,"id");const auto& waypoints=sequence.at("waypoints");
            if(!sequenceIds.insert(id).second||!waypoints.is_array()||waypoints.empty()||waypoints.size()>64)throw Invalid("Invalid sequence id or waypoints");
            std::vector<std::map<std::size_t,double>> points;std::map<std::size_t,double> target;
            for(std::size_t i=0;i<connections.size();++i)if(connections[i].kind!="fixed")target[i]=0;
            for(const auto& point:waypoints) {
                if(++total>256||!point.is_object()||point.empty())throw Invalid("Invalid or excessive sequence waypoints");
                for(auto it=point.begin();it!=point.end();++it) {
                    if(!ids.count(it.key()))throw Invalid("Sequence names an unknown connection");auto index=ids.at(it.key());const auto& c=connections[index];
                    if(c.kind=="fixed")throw Invalid("Sequence cannot drive a fixed connection");double scale=c.kind=="revolute"?pi/180:.001;
                    target[index]=number(point,it.key(),c.low/scale,c.high/scale)*scale;
                }
                points.push_back(target);
            }
            sequences.push_back({id,points});
        }
    }
    Json checks=Json::array(),results=Json::array(),completedSequences=Json::array();bool repair=false,review=false;int budget=0;
    for(const auto& c:connections)results.push_back({{"id",c.id},{"parent",c.parentId},{"child",c.childId},{"kind",c.kind},{"probes",Json::array()}});
    auto finding=[&](std::string code,std::string id,std::string severity,Json details) {checks.push_back({{"code",code},{"connection",id},{"severity",severity},{"count",1},{"details",details}});repair|=severity=="error";review|=severity=="warning";};
    for(const auto& b:bodies)if(!b.topology.empty())finding(b.topology,"",b.topology=="unsupported_body_topology"?"warning":"error",{{"body",b.id}});
    if(parents[fixture]!=0 || std::any_of(parents.begin(),parents.end(),[](int n){return n>1;}))finding("unsupported_coupled_motion","","warning",{{"reason","closed_loop_or_multiple_parent"}});
    bool simulate=!repair&&!review;
    double estimated=std::ceil(s.restDuration/s.dt),retentionTotal=0;
    for(const auto& c:connections)retentionTotal+=(c.kind=="fixed"?12:10)*std::ceil(s.retentionDuration/s.dt);
    estimated+=retentionTotal;
    for(const auto& c:connections) {
        if(c.kind!="fixed")for(double endpoint:{c.low,c.high})if(endpoint!=0) {
            double spacing=c.kind=="revolute"?s.movementDegrees*pi/180:s.movementMm*.001;
            estimated+=(std::ceil(std::abs(endpoint)/spacing)+1)*(std::ceil(s.duration/s.dt)+retentionTotal);
        }
    }
    for(const auto& sequence:sequences)estimated+=sequence.second.size()*(std::ceil(s.duration/s.dt)+retentionTotal);
    bool fullBudget=estimated<=s.maxTotalSteps;
    if(!fullBudget)finding("probe_budget_exhausted","","warning",{{"estimatedSteps",estimated},{"maximumSteps",s.maxTotalSteps}});
    auto accept=[&](Trial& t,std::size_t index) {
        if(index<results.size())results[index]["probes"].push_back(t.result);
        else for(auto& result:results)result["probes"].push_back(t.result);
        if(t.result.at("status")!="passed") {
            finding(t.result.at("code"),t.result.value("connection",index<connections.size()?connections[index].id:""),t.result.at("status")=="review"?"warning":"error",t.result);return false;
        }
        return true;
    };
    std::vector<std::vector<Body>> workerBodies;
    bool parallelRetention=false;
    auto loads=[&](std::size_t index,const State& state,const std::vector<btVector3>& axes,double amount,bool rotation) {
        const int workers=parallelRetention?s.retentionWorkers:1;
        if(workers>1 && workerBodies.empty())
            for(int i=0;i<workers;++i)workerBodies.push_back(cloneBodies(bodies));
        const int steps=int(std::ceil(s.retentionDuration/s.dt));
        for(std::size_t start=0;start<axes.size()*2;start+=workers) {
            const int count=std::min(workers,int(axes.size()*2-start));
            auto probe=[&](int offset,std::vector<Body>& geometry) {
                const auto load=axes[(start+offset)/2]*((start+offset)%2?amount:-amount);
                int reserved=budget+offset*steps;
                return trial(geometry,fixture,connections,s,&state,{},index,
                    rotation?btVector3(0,0,0):load,rotation?load:btVector3(0,0,0),"retention",s.retentionDuration,reserved);
            };
            std::vector<Trial> trials;
            if(workers==1)trials.push_back(probe(0,bodies));
            else {
                std::vector<std::future<Trial>> pending;
                for(int i=0;i<count;++i)pending.push_back(std::async(std::launch::async,[&,i] {return probe(i,workerBodies[i]);}));
                for(auto& future:pending)trials.push_back(future.get());
            }
            // Publish in serial order, including budget failures, independent of worker scheduling.
            for(auto& t:trials) {
                if(budget+steps<=s.maxTotalSteps)budget+=steps;
                if(!accept(t,index))return false;
            }
        }
        return true;
    };
    auto retention=[&](std::size_t index,const State& state) {
        const auto& c=connections[index];const auto& child=bodies[c.child];const auto& parent=bodies[c.parent];
        double inverseMass=1/child.mass+(c.parent==fixture?0:1/parent.mass),mass=1/inverseMass;
        std::vector<btVector3> translations{c.transverse,c.binormal},rotations{c.transverse,c.binormal};
        if(c.kind!="prismatic")translations.push_back(c.axis);if(c.kind!="revolute")rotations.push_back(c.axis);
        double force=8*mass*s.linearTolerance/(s.retentionDuration*s.retentionDuration);
        if(force>s.force) {finding("probe_inconclusive",c.id,"warning",{{"reason","force_cap"}});return false;}
        if(!loads(index,state,translations,force,false))return false;
        for(auto axis:rotations) {
            auto worldAxis=state.transforms[c.parent].getBasis()*axis;
            auto childBasis=state.transforms[c.child].getBasis(),parentBasis=state.transforms[c.parent].getBasis();
            double inverse=worldAxis.dot(childBasis*btMatrix3x3(1/child.moments.x(),0,0,0,1/child.moments.y(),0,0,0,1/child.moments.z())*childBasis.transpose()*worldAxis);
            if(c.parent!=fixture)inverse+=worldAxis.dot(parentBasis*btMatrix3x3(1/parent.moments.x(),0,0,0,1/parent.moments.y(),0,0,0,1/parent.moments.z())*parentBasis.transpose()*worldAxis);
            double torque=8/inverse*s.angularTolerance/(s.retentionDuration*s.retentionDuration);
            if(torque>s.torque) {finding("probe_inconclusive",c.id,"warning",{{"reason","torque_cap"}});return false;}
            if(!loads(index,state,{axis},torque,true))return false;
        }
        return true;
    };
    if(simulate) {
        auto rest=trial(bodies,fixture,connections,s,nullptr,{},connections.size(),{0,0,0},{0,0,0},"rest",s.restDuration,budget);
        simulate=accept(rest,connections.size());
        for(std::size_t i=0;i<connections.size()&&simulate;++i)simulate=retention(i,rest.finalState);
        if(!fullBudget)simulate=false;
        parallelRetention=true;
        for(std::size_t i=0;i<connections.size()&&simulate;++i) {
            const auto& c=connections[i];if(c.kind=="fixed")continue;
            for(double endpoint:{c.low,c.high})if(endpoint!=0&&simulate) {
                double tolerance=c.kind=="revolute"?s.angularTolerance:s.linearTolerance;
                if(std::abs(endpoint)<=tolerance) {finding("probe_inconclusive",c.id,"warning",{{"reason","movement_below_tolerance"}});simulate=false;break;}
                State state=rest.finalState;
                int samples=int(std::ceil(std::abs(endpoint)/(c.kind=="revolute"?s.movementDegrees*pi/180:s.movementMm*.001)));
                std::vector<double> targets;for(int n=1;n<=samples;++n)targets.push_back(endpoint*n/samples);targets.push_back(0);
                for(double target:targets) {
                    auto movement=trial(bodies,fixture,connections,s,&state,{{i,target}},connections.size(),{0,0,0},{0,0,0},"movement",s.duration,budget);
                    if(!accept(movement,i)){simulate=false;break;}state=movement.finalState;
                    for(std::size_t other=0;other<connections.size();++other)if(!retention(other,state)){simulate=false;break;}
                    if(!simulate)break;
                }
            }
        }
        for(const auto& [id,points]:sequences)if(simulate) {
            State state=rest.finalState;bool complete=true;
            for(const auto& target:points) {
                auto t=trial(bodies,fixture,connections,s,&state,target,connections.size(),{0,0,0},{0,0,0},"sequence",s.duration,budget);t.result["sequence"]=id;
                if(!accept(t,connections.size())){complete=false;simulate=false;break;}state=t.finalState;
                for(std::size_t i=0;i<connections.size();++i)if(!retention(i,state)){complete=false;simulate=false;break;}
                if(!complete)break;
            }
            if(complete)completedSequences.push_back(id);
        }
    }
    bool complete=simulate;
    Json routeSteps=Json::array();
    if(mode=="separate" && complete) {
        auto route=assemblyRoute(bodies,fixture,a.at("manufacturing"),s,budget);routeSteps=route.steps;
        if(route.status!="passed") {complete=false;finding(route.code,"",route.status=="needs_repair"?"error":"warning",route.details);}
    }
    Json partIds=Json::array(),connectionIds=Json::array();for(auto& b:bodies)partIds.push_back(b.id);if(complete)for(auto& c:connections)connectionIds.push_back(c.id);
    return {{"version",2},{"engine","bullet"},{"bulletVersion",btGetVersion()},{"precision","double"},{"status",repair?"needs_repair":review?"review":"passed"},
      {"printReady",false},{"assemblyVerified",complete&&!repair&&!review},{"checks",checks},{"connections",results},
      {"coverage",{{"parts",partIds},{"connections",connectionIds},{"sequences",completedSequences},{"assemblySteps",routeSteps},{"complete",complete}}},{"policy",request.at("settings")}};
}
Json selfTest() {
    auto box=[](const std::string& id,btVector3 center,btVector3 half) {
        Json vertices=Json::array();
        for(auto point:std::vector<btVector3>{{-1,-1,-1},{1,-1,-1},{1,1,-1},{-1,1,-1},{-1,-1,1},{1,-1,1},{1,1,1},{-1,1,1}}) vertices.push_back(coordinates(center+half*point));
        return Json{{"id",id},{"vertices",vertices},{"triangles",{{0,2,1},{0,3,2},{4,5,6},{4,6,7},{0,1,5},{0,5,4},{1,2,6},{1,6,5},{2,3,7},{2,7,6},{3,0,4},{3,4,7}}}};
    };
    Settings s{.0005,.2,.02,.05,1250,1,.05,.0005,3*pi/180,.00005,40,2000000,1,{0,0,0},0,15,2,.2};
    std::size_t triangles=0,vertices=0; std::vector<Body> definitions;
    definitions.push_back(body(box("fixed",{0,-3,0},{5,1,5}),s,triangles,vertices));
    definitions.push_back(body(box("moving",{0,0,0},{1,1,1}),s,triangles,vertices));
    if(!definitions[0].topology.empty() || !definitions[1].topology.empty()) throw std::runtime_error("Self-test box geometry failed validation");
    World simulation(definitions,0,s);
    for(int i=0;i<400;++i) {simulation.bodies[1]->applyCentralForce(btVector3(0,-5*definitions[1].mass,0));simulation.world.stepSimulation(s.dt,0,s.dt);}
    double displacement=-simulation.bodies[1]->getCenterOfMassPosition().y(); bool ok=displacement>.0009 && displacement<.0011;
    return {{"ok",ok},{"protocolVersion",2},{"bulletVersion",btGetVersion()},{"precision","double"},{"contactStopMm",displacement*1000}};
}
int main(int argc,char** argv) {
    try {
        static_assert(sizeof(btScalar)==8,"Rumi requires double-precision Bullet");
        gContactBreakingThreshold=1e-5;
        if(argc==2 && std::string(argv[1])=="--version") {std::cout<<Json{{"protocolVersion",2},{"bulletVersion",btGetVersion()},{"precision","double"}}<<'\n';return 0;}
        if(argc==2 && std::string(argv[1])=="--self-test") {auto result=selfTest();std::cout<<result<<'\n';return result.at("ok").get<bool>()?0:1;}
        if(argc!=1) throw Invalid("Use JSON on stdin, --version, or --self-test");
        std::string input; std::array<char,65536> chunk;
        while(std::cin) {std::cin.read(chunk.data(),chunk.size()); auto count=std::cin.gcount(); if(input.size()+count>maxInputBytes) throw Invalid("Request exceeds 64 MiB");input.append(chunk.data(),std::size_t(count));}
        auto started=Clock::now(); auto parsed=Json::parse(input,[](int depth,Json::parse_event_t,Json&) {if(depth>32) throw Invalid("JSON nesting exceeds 32 levels");return true;}); auto result=evaluate(parsed);
        result["elapsedMs"]=std::chrono::duration<double,std::milli>(Clock::now()-started).count(); std::cout<<result<<'\n';return 0;
    } catch(const Invalid& error) {std::cout<<Json{{"version",2},{"error",{{"code","invalid_request"},{"message",error.what()}}}}<<'\n';return 2;}
      catch(const Json::exception& error) {std::cout<<Json{{"version",2},{"error",{{"code","invalid_request"},{"message",error.what()}}}}<<'\n';return 2;}
      catch(const std::exception& error) {std::cout<<Json{{"version",2},{"error",{{"code","simulation_failed"},{"message",error.what()}}}}<<'\n';return 1;}
}
