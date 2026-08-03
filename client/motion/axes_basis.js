'use strict';
const core= require('../../core/core.js');

//! Basis vectors per axes standard, for controllers that need to know which way is up
//! and which way a node with identity orientation faces.
//!
//! Server-side code works in the server's axes standard, which defaults to
//! EngineeringStyle — Z-vertical, not Y. Anything that hard-codes Y as up is wrong for
//! the default configuration, which is why this table exists.
//!
//! Verified against core.ConvertPosition: Engineering +Y maps to Unity +Z and GL -Z (both
//! "forward"), Engineering +Z maps to up in both, and Unreal +X maps to Engineering +Y.
//!
//!   EngineeringStyle  right-handed, Z up:  (x,y,z) = (right, forward, up)
//!   UnrealStyle       left-handed,  Z up:  (x,y,z) = (forward, right, up)
//!   GlStyle           right-handed, Y up:  (x,y,z) = (right, up, back)
//!   UnityStyle        left-handed,  Y up:  (x,y,z) = (right, up, forward)
const BASES = {
	[core.AxesStandard.EngineeringStyle]: { up:{x:0,y:0,z:1}, forward:{x:0,y:1,z:0} },
	[core.AxesStandard.UnrealStyle]:      { up:{x:0,y:0,z:1}, forward:{x:1,y:0,z:0} },
	[core.AxesStandard.GlStyle]:          { up:{x:0,y:1,z:0}, forward:{x:0,y:0,z:-1} },
	[core.AxesStandard.UnityStyle]:       { up:{x:0,y:1,z:0}, forward:{x:0,y:0,z:1} },
};

//! Basis for an axes standard. Falls back to EngineeringStyle, the server default.
function BasisFor(axesStandard)
{
	const b=BASES[axesStandard];
	if(b)
		return b;
	console.warn("axes_basis: unknown axes standard "+axesStandard+"; assuming EngineeringStyle");
	return BASES[core.AxesStandard.EngineeringStyle];
}

//! Which component of a vector is the vertical one: 'x', 'y' or 'z'.
function VerticalComponent(axesStandard)
{
	const up=BasisFor(axesStandard).up;
	return up.z?'z':(up.y?'y':'x');
}

function dot(a,b){ return a.x*b.x+a.y*b.y+a.z*b.z; }
function cross(a,b){
	return { x:a.y*b.z-a.z*b.y, y:a.z*b.x-a.x*b.z, z:a.x*b.y-a.y*b.x };
}
function scale(v,s){ return {x:v.x*s, y:v.y*s, z:v.z*s}; }
function sub(a,b){ return {x:a.x-b.x, y:a.y-b.y, z:a.z-b.z}; }
function add(a,b){ return {x:a.x+b.x, y:a.y+b.y, z:a.z+b.z}; }
function length(v){ return Math.sqrt(dot(v,v)); }
function normalise(v){
	const l=length(v);
	return l>1e-9?scale(v,1.0/l):{x:0,y:0,z:0};
}

//! v' = v + 2 * cross(q.xyz, cross(q.xyz, v) + q.w * v)
function RotateVector(q,v)
{
	if(!q)
		return {x:v.x, y:v.y, z:v.z};
	const tx=2*(q.y*v.z-q.z*v.y);
	const ty=2*(q.z*v.x-q.x*v.z);
	const tz=2*(q.x*v.y-q.y*v.x);
	return {
		x: v.x+q.w*tx+(q.y*tz-q.z*ty),
		y: v.y+q.w*ty+(q.z*tx-q.x*tz),
		z: v.z+q.w*tz+(q.x*ty-q.y*tx),
	};
}

//! Remove the component of v along the vertical axis.
function Horizontal(v,up)
{
	return sub(v,scale(up,dot(v,up)));
}

//! The two components of v that lie in the horizontal plane, as [a,b], for passing to a
//! ground provider. Which two they are depends on which axis is vertical: Z-up bases give
//! [x,y], Y-up bases give [x,z].
function HorizontalComponents(v,up)
{
	if(up.z) return [v.x,v.y];
	if(up.y) return [v.x,v.z];
	return [v.y,v.z];
}

//! Signed angle in radians from direction `from` to direction `to`, about `up`.
//! Both directions are expected to be horizontal; the result is in [-pi, pi].
function SignedAngleAbout(from,to,up)
{
	return Math.atan2(dot(cross(from,to),up),dot(from,to));
}

//! Quaternion rotating `basisForward` to `direction` about `up`, i.e. the orientation a
//! node needs so that it faces `direction`. Handedness-agnostic: it is built from the
//! actual basis vectors rather than assuming a yaw convention.
function OrientationFacing(direction,basis)
{
	const theta=SignedAngleAbout(basis.forward,normalise(direction),basis.up);
	return QuaternionAbout(basis.up,theta);
}

//! Quaternion for a rotation of `angle` radians about unit `axis`.
function QuaternionAbout(axis,angle)
{
	const h=angle*0.5;
	const s=Math.sin(h);
	return { x:axis.x*s, y:axis.y*s, z:axis.z*s, w:Math.cos(h) };
}

//! Wrap an angle to [-pi, pi], so smoothing takes the shortest arc.
function WrapAngle(a)
{
	const twoPi=Math.PI*2;
	a=a%twoPi;
	if(a>Math.PI) a-=twoPi;
	if(a<-Math.PI) a+=twoPi;
	return a;
}

module.exports= {BasisFor,VerticalComponent,RotateVector,Horizontal,HorizontalComponents,SignedAngleAbout,
	OrientationFacing,QuaternionAbout,WrapAngle,
	dot,cross,scale,sub,add,length,normalise};
