'use strict';

//! Where the ground is, for controllers that keep something standing on it.
//!
//! A provider is any object with groundHeightAt(x, z) -> number, in the space the
//! controller works in. For a node parented under a client's origin node that is the
//! client's stage space, whose y=0 plane is the floor the client is standing on (the
//! OpenXR stage-space convention), so FlatGround(0) is correct for a level room and is
//! the default.
//!
//! This is a hook, not a scene query: the Node scene graph carries no bounds, collision
//! or terrain data, so anything cleverer has to come from the host application. Supplying
//! a different provider is how you add terrain later — the controller does not change.
class FlatGround
{
	constructor(height=0.0)
	{
		this.height=height;
	}
	groundHeightAt(x,z)
	{
		return this.height;
	}
}

//! Ground height from a host-supplied function, e.g. a heightmap lookup or a physics
//! raycast. Wrapped so controllers only ever see the groundHeightAt interface.
class CallbackGround
{
	constructor(fn)
	{
		if(typeof fn!=='function')
			throw new Error("CallbackGround requires a function");
		this.fn=fn;
	}
	groundHeightAt(x,z)
	{
		const h=this.fn(x,z);
		return Number.isFinite(h)?h:0.0;
	}
}

module.exports= {FlatGround,CallbackGround};
