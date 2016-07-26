import { get } from 'ember-metal/property_get';
import { set } from 'ember-metal/property_set';
import { tagFor } from 'ember-metal/tags';
import { didRender } from 'ember-metal/transaction';
import symbol from 'ember-metal/symbol';
import { CURRENT_TAG, CONSTANT_TAG, VOLATILE_TAG, ConstReference, DirtyableTag, UpdatableTag, combine, isConst } from 'glimmer-reference';
import { ConditionalReference as GlimmerConditionalReference, NULL_REFERENCE, UNDEFINED_REFERENCE } from 'glimmer-runtime';
import emberToBool from './to-bool';
import { RECOMPUTE_TAG } from '../helper';
import { dasherize } from 'ember-runtime/system/string';
import { meta as metaFor } from 'ember-metal/meta';
import { watchKey } from 'ember-metal/watch_key';
import isEnabled from 'ember-metal/features';
import { isProxy } from 'ember-runtime/mixins/-proxy';

export const UPDATE = symbol('UPDATE');
export const TO_ROOT_REFERENCE = symbol('TO_ROOT_REFERENCE');
export const REFERENCE_FOR_KEY = symbol('REFERENCE_FOR_KEY');

// @implements PathReference
export class PrimitiveReference extends ConstReference {
  get() {
    return UNDEFINED_REFERENCE;
  }
}

export { NULL_REFERENCE, UNDEFINED_REFERENCE } from 'glimmer-runtime';

// @abstract
// @implements PathReference
class EmberPathReference {
  // @abstract get tag()
  // @abstract value()

  get(key) {
    return new PropertyReference(this, key);
  }
}

// @abstract
export class CachedReference extends EmberPathReference {
  constructor() {
    super();
    this._lastRevision = null;
    this._lastValue = null;
  }

  value() {
    let { tag, _lastRevision, _lastValue } = this;

    if (!_lastRevision || !tag.validate(_lastRevision)) {
      this._lastRevision = tag.value();
      _lastValue = this._lastValue = this.compute();
    }

    return _lastValue;
  }

  invalidate() {
    this._lastRevision = null;
  }

  // @abstract compute()
}

// @implements PathReference
export class RootReference extends ConstReference {
  get(propertyKey) {
    let self = this.value();
    let ref = self[REFERENCE_FOR_KEY] && self[REFERENCE_FOR_KEY](propertyKey);

    if (isEnabled('mandatory-setter')) {
      if (ref) {
        let _ref = ref;

        ref = Object.create(ref);

        ref.value = function() {
          let meta = metaFor(self);
          watchKey(self, propertyKey, meta);
          return _ref.value();
        };
      }
    }

    return ref || new PropertyReference(this, propertyKey);
  }
}

let TwoWayFlushDetectionTag;

if (isEnabled('ember-glimmer-detect-backtracking-rerender') ||
    isEnabled('ember-glimmer-allow-backtracking-rerender')) {
  TwoWayFlushDetectionTag = class {
    constructor(tag, key, ref) {
      this.tag = tag;
      this.parent = null;
      this.key = key;
      this.ref = ref;
    }

    value() {
      return this.tag.value();
    }

    validate(ticket) {
      let { parent, key } = this;

      let isValid = this.tag.validate(ticket);

      if (isValid && parent) {
        didRender(parent, key, this.ref);
      }

      return isValid;
    }

    didCompute(parent) {
      this.parent = parent;
      didRender(parent, this.key, this.ref);
    }
  };
}

export class PropertyReference extends CachedReference { // jshint ignore:line
  constructor(parentReference, propertyKey) {
    super();

    let parentReferenceTag = parentReference.tag;
    let parentObjectTag = new UpdatableTag(CURRENT_TAG);

    this._parentReference = parentReference;
    this._parentObjectTag = parentObjectTag;
    this._propertyKey = propertyKey;

    if (isEnabled('ember-glimmer-detect-backtracking-rerender') ||
        isEnabled('ember-glimmer-allow-backtracking-rerender')) {
      let tag = combine([parentReferenceTag, parentObjectTag]);
      this.tag = new TwoWayFlushDetectionTag(tag, propertyKey, this);
    } else {
      this.tag = combine([parentReferenceTag, parentObjectTag]);
    }
  }

  compute() {
    let { _parentReference, _parentObjectTag, _propertyKey } = this;

    let parentValue = _parentReference.value();

    if (isProxy(parentValue)) {
      _parentObjectTag.update(VOLATILE_TAG);
    } else {
      _parentObjectTag.update(tagFor(parentValue));
    }

    if (typeof parentValue === 'object' && parentValue) {
      if (isEnabled('mandatory-setter')) {
        let meta = metaFor(parentValue);
        watchKey(parentValue, _propertyKey, meta);
      }

      if (isEnabled('ember-glimmer-detect-backtracking-rerender') ||
          isEnabled('ember-glimmer-allow-backtracking-rerender')) {
        this.tag.didCompute(parentValue);
      }

      return get(parentValue, _propertyKey);
    } else {
      return null;
    }
  }

  [UPDATE](value) {
    let parent = this._parentReference.value();
    set(parent, this._propertyKey, value);
  }

  get(propertyKey) {
    return new PropertyReference(this, propertyKey);
  }
}

export class UpdatableReference extends EmberPathReference {
  constructor(value) {
    super();

    this.tag = new DirtyableTag();
    this._value = value;
  }

  value() {
    return this._value;
  }

  update(value) {
    this.tag.dirty();
    this._value = value;
  }
}

export class UpdatablePrimitiveReference extends UpdatableReference {
  get() {
    return UNDEFINED_REFERENCE;
  }
}

export class ConditionalReference extends GlimmerConditionalReference {
  static create(reference) {
    if (isConst(reference)) {
      let value = reference.value();

      if (!isProxy(value)) {
        return new PrimitiveReference(emberToBool(value));
      }
    }

    return new ConditionalReference(reference);
  }

  constructor(reference) {
    super(reference);

    this.objectTag = new UpdatableTag(CURRENT_TAG);
    this.tag = combine([reference.tag, this.objectTag]);
  }

  toBool(predicate) {
    if (isProxy(predicate)) {
      this.objectTag.update(VOLATILE_TAG);
      return get(predicate, 'isTruthy');
    } else {
      this.objectTag.update(tagFor(predicate));
      return emberToBool(predicate);
    }
  }
}

export class SimpleHelperReference extends CachedReference {
  static create(helper, args) {
    if (isConst(args)) {
      let { positional, named } = args;
      let result = helper(positional.value(), named.value());

      if (result === null) {
        return NULL_REFERENCE;
      } else if (result === undefined) {
        return UNDEFINED_REFERENCE;
      } else if (typeof result === 'object') {
        return new RootReference(result);
      } else {
        return new PrimitiveReference(result);
      }
    } else {
      return new SimpleHelperReference(helper, args);
    }
  }

  constructor(helper, args) {
    super();

    this.tag = args.tag;
    this.helper = helper;
    this.args = args;
  }

  compute() {
    let { helper, args: { positional, named } } = this;
    return helper(positional.value(), named.value());
  }
}

export class ClassBasedHelperReference extends CachedReference {
  static create(helperClass, vm, args) {
    let instance = helperClass.create();
    vm.newDestroyable(instance);
    return new ClassBasedHelperReference(instance, args);
  }

  constructor(instance, args) {
    super();

    this.tag = combine([instance[RECOMPUTE_TAG], args.tag]);
    this.instance = instance;
    this.args = args;
  }

  compute() {
    let { instance, args: { positional, named } } = this;
    return instance.compute(positional.value(), named.value());
  }
}

export class InternalHelperReference extends CachedReference {
  constructor(helper, args) {
    super();

    this.tag = args.tag;
    this.helper = helper;
    this.args = args;
  }

  compute() {
    let { helper, args } = this;
    return helper(args);
  }
}

import { assert } from 'ember-metal/debug';

export class AttributeBindingReference extends CachedReference {
  static apply(component, parsedMicroSyntax, operations) {
    let reference;
    let prop = parsedMicroSyntax[0];
    let attr;

    if (parsedMicroSyntax.length === 1) {
      reference = new this(component, prop);
    } else {
      attr = parsedMicroSyntax[1];
      reference = new this(component, prop, attr);
    }

    operations.addAttribute(reference.attributeName, reference);
  }

  static parseMicroSyntax(microsyntax) {
    let colonIndex = microsyntax.indexOf(':');

    if (colonIndex === -1) {
      assert('You cannot use class as an attributeBinding, use classNameBindings instead.', microsyntax !== 'class');
      return [microsyntax];
    } else {
      let prop = microsyntax.substring(0, colonIndex);
      let attr = microsyntax.substring(colonIndex + 1);

      assert('You cannot use class as an attributeBinding, use classNameBindings instead.', attr !== 'class');

      return [prop, attr];
    }
  }

  constructor(component, propertyPath, attributeName=propertyPath) {
    super();

    if (propertyPath.indexOf('.') > -1) {
      // For bindings like `foo.bar.baz`, just checking the tag for the component itself is not enough.
      this.tag = CURRENT_TAG;
    } else {
      this.tag = tagFor(component);
    }

    this.component = component;
    this.propertyPath = propertyPath;
    this.attributeName = attributeName;
  }

  compute() {
    let value = get(this.component, this.propertyPath);

    if (value === null || value === undefined || value === false) {
      return null;
    } else if (value === true) {
      // Note:
      // This is here to mimic functionality in HTMLBars for properties.
      // For instance when a property like "disable" is set all of these
      // forms are valid and have the same disabled functionality:
      //
      // <input disabled />
      // <input disabled="true" />
      // <input disabled="false" />
      // <input disabled="" />
      //
      // For compatability sake we do not just cast the true boolean to
      // a string. Potentially we can revisit this in the future as the
      // casting feels better and we can remove this branch.
      return '';
    } else {
      return value;
    }
  }
}

export function applyClassNameBinding(component, microsyntax, operations) {
  let [ prop, truthy, falsy ] = microsyntax.split(':');
  let ref;

  if (truthy !== undefined) {
    ref = new ColonClassNameBindingReference(component, prop, truthy, falsy);
  } else {
    ref = new SimpleClassNameBindingReference(component, prop);
  }

  operations.addAttribute('class', ref);
}

class SimpleClassNameBindingReference extends CachedReference {
  constructor(component, propertyPath) {
    super();

    if (propertyPath.indexOf('.') > -1) {
      // For bindings like `foo.bar.baz`, just checking the tag for the component itself is not enough.
      this.tag = CURRENT_TAG;
    } else {
      this.tag = tagFor(component);
    }

    this.component = component;
    this.propertyPath = propertyPath;
  }

  compute() {
    let value = get(this.component, this.propertyPath);

    if (value === true) {
      return propertyPathToClassName(this.propertyPath);
    } else if (value || value === 0) {
      return value;
    } else {
      return null;
    }
  }
}

class ColonClassNameBindingReference extends CachedReference {
  constructor(component, propertyPath, truthy, falsy) {
    super();

    if (propertyPath.indexOf('.') > -1) {
      // For bindings like `foo.bar.baz`, just checking the tag for the component itself is not enough.
      this.tag = CURRENT_TAG;
    } else {
      this.tag = tagFor(component);
    }

    this.component = component;
    this.propertyPath = propertyPath;
    this.truthy = truthy || null;
    this.falsy = falsy || null;
  }

  compute() {
    let value = get(this.component, this.propertyPath);
    return !!value ? this.truthy : this.falsy;
  }
}

function propertyPathToClassName(propertyPath) {
  let parts = propertyPath.split('.');
  let last = parts[parts.length - 1];

  return dasherize(last);
}

const EMPTY_OBJECT = {};

// @implements PathReference
export class UnboundReference {
  constructor(sourceRef, key = null) {
    this.tag = CONSTANT_TAG;
    this.sourceRef = sourceRef;
    this.key = key;
    this.cache = EMPTY_OBJECT;
  }

  value() {
    let { cache } = this;

    if (cache === EMPTY_OBJECT) {
      let { key, sourceRef } = this;
      let sourceVal = sourceRef.value();
      cache = this.cache = key ? get(sourceVal, key) : sourceVal;
    }

    return cache;
  }

  get(key) {
    return new UnboundReference(this, key);
  }
}
