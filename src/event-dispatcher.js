const slice = Array.prototype.slice;

/**
 * Simple event dispatcher
 */
export default class EventDispatcher {

  constructor() {
    // Define a non-enumerable "private" property to hold all event listeners
    Object.defineProperty(this, '_events', { configurable: true, writable: true, value: {} });
  }

  /**
   * Adds an event listener
   */
  on(type, listener) {
    this._events[type] = getEventListeners(this, type).concat([listener]);
    return this;
  }

  /**
   * Adds an event listener to be triggered only once
   */
  once(type, listener) {
    this.on(type, function wrap() {
      this.off(type, wrap);
      listener.apply(this, arguments);
    });
    return this;
  }

  /**
   * Removes a previously added event listener
   */
  off(type, listener) {
    this._events[type] = getEventListeners(this, type).filter(function(l) {
      return l !== listener;
    });
    return this;
  }

  /**
   * Checks if there are any event listeners for this event
   */
  hasListeners(type) {
    return getEventListeners(this, type).length > 0;
  }

  /**
   * Dispatches an event calling all listeners with the given args (minus type).
   */
  dispatchEvent(type /*[, args]*/) {
    var args = slice.call(arguments, 1);
    getEventListeners(this, type).forEach(function(listener) {
      listener.apply(this, args);
    }, this);
    return this;
  }

  /**
   * Dispatches an event but stops on the first listener to return false. Returns true if no listeners cancel the
   * action. Use for "cancelable" actions to check if they can be performed.
   */
  dispatchCancelableEvent(type /*[, args]*/) {
    var args = slice.call(arguments, 1);
    return getEventListeners(this, type).every(function(listener) {
      return listener.apply(this, args) !== false;
    }, this);
  }

  removeAllEvents() {
    this._events = {};
  }
}


/**
 * Get the listeners for the given object by the given event type.
 */
function getEventListeners(obj, type) {
  var listeners = obj._events[type];
  if (!listeners) {
    obj._events[type] = listeners = [];
  }
  return listeners;
}
