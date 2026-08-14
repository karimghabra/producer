#pragma once

// ---------------------------------------------------------------------------
// Motif — the project format.
//
// A song written to text and read back. Instrument parameters go through the
// table in Params.h rather than being listed again here, so a parameter cannot
// be added to the engine and then silently not saved.
//
// Reading is deliberately forgiving: anything missing keeps its default. A
// project written by an older version stays loadable, and a field added later
// simply appears with its default value rather than making the file invalid.
// ---------------------------------------------------------------------------

#include <string>
#include <vector>

#include "music/Song.h"

namespace motif {

/** Serialise a song. Pretty-printed - it is meant to be readable. */
std::string songToJson(const Song& song);

/**
 * Parse a song.
 *
 * Returns false and leaves `out` untouched if the text is not valid JSON or
 * carries no tracks. A half-loaded project is worse than a refused one.
 */
bool songFromJson(const std::string& text, Song& out, std::string& error);

/** Where projects live: Documents/Motif/Projects. Created on first use. */
std::string projectsDirectory();

/** Names of the saved projects, without the extension, alphabetically. */
std::vector<std::string> listProjects();

/**
 * Strip anything that cannot go in a filename.
 *
 * Names come from a text field in the interface, and a project called
 * "../../autoexec" must not be able to decide where it is written.
 */
std::string sanitiseProjectName(const std::string& name);

bool saveProject(const std::string& name, const Song& song, std::string& error);
bool loadProject(const std::string& name, Song& out, std::string& error);
bool deleteProject(const std::string& name);

} // namespace motif
