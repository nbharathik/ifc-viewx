# Assistant

The optional assistant works with the model currently open in IFCViewX. It can
search for elements, explain properties, make selections and adjust the view.
For example, you can ask it to find external walls on a storey or isolate doors
with a specific property.

## Set it up

Open **Assistant settings**, choose a provider and model, then add your API key
and verify the connection. You can change or remove these settings at any time.

The browser stores the key locally. [Local Studio](local-studio.md) can keep it
in its local key vault instead.

## Privacy and safety

The provider receives your question, a small summary of the current viewer and
only the model results needed for the answer. The complete IFC file is not
uploaded. A viewport image is sent only when you attach one to that request.

The assistant can change the view in reversible ways. It may also prepare a
model edit, but it cannot apply the edit or run Python for you. Every proposed
model change must be reviewed and approved in the viewer.
