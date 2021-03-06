/**
@module ember
@submodule ember-templates
*/

import EmberError from 'ember-metal/error';
import { compile } from 'ember-template-compiler';
import {
  has as hasTemplate,
  set as registerTemplate
} from 'ember-templates/template_registry';

/**
@module ember
@submodule ember-templates
*/

/**
  Find templates stored in the head tag as script tags and make them available
  to `Ember.CoreView` in the global `Ember.TEMPLATES` object.

  Script tags with `text/x-handlebars` will be compiled
  with Ember's template compiler and are suitable for use as a view's template.

  @private
  @method bootstrap
  @for Ember.HTMLBars
  @static
  @param ctx
*/
function bootstrap(context = document) {
  let selector = 'script[type="text/x-handlebars"]';

  let elements = context.querySelectorAll(selector);

  for (let i = 0; i < elements.length; i++) {
    let script = elements[i];

    // Get the name of the script
    // First look for data-template-name attribute, then fall back to its
    // id if no name is found.
    let templateName = script.getAttribute('data-template-name') || script.getAttribute('id') || 'application';
    let template;

    template = compile(script.innerHTML, {
      moduleName: templateName
    });

    // Check if template of same name already exists.
    if (hasTemplate(templateName)) {
      throw new EmberError('Template named "' + templateName  + '" already exists.');
    }

    // For templates which have a name, we save them and then remove them from the DOM.
    registerTemplate(templateName, template);

    // Remove script tag from DOM.
    script.parentNode.removeChild(script);
  }
}

export default bootstrap;
