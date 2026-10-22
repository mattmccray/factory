
# General

- Like to add a lot more observability metrics to jobs. So I would like for us just track if we're not already, I'm not sure. If we aren't, then we should expose it, but the start timestamp, like a date timestamp and then durations for each phase so we can kind of get a sense of how long each of the jobs/phases took and that would help users tune the size of jobs  and whatnot. 
- We need to formalize the exact data that's tracked and stored in the factory folders and so that we can have a dashboard application that can cross multiple projects. (See note below.) While factories can be customized for each project because there are certain reviewers that may change, processes, application types, all that, but the factory itself, that interface layer should be fixed.
- Probably should give this a name? Or maybe not. Maybe factory is fine. Maybe it should be "The Factory"?
- Should be extended to be able to support Codex, Pi, and Open Code as well as Claude Code. 
- when the interface for the is fully defined for the jobs and how it communicates with the dashboard, it'd be nice to update @factory-prompt.temp.md file to represent the current factory design. 

# Application

- An application (desktop or web?) that allows you to view the orchestrator's status across multiple projects. 
- Projects are defined as basically folders and those folders will have the factory skills and folder with all the state info. 
- The application should probably set up file watchers as opposed to having a UI that polls. I think that would make sense. 
- If it's a desktop application, it becomes a nice dashboard for all the various projects, factories, and their statuses. 
- In future might consider being able to extend the view across multiple machines. So if you have agent-specific development machines, you can see the life cycles across multiple machines. That would of course require maybe services where you would register the projects to the service and then the orchestrator or dashboard application would actually then connect to those various services. And those services would then be the ones with the file watchers or however it is that they decide a job status has changed. 
- I'm leaning towards a Tiny JS application. (https://tinyjs.app/docs.html#cli)

# Skill Updates

- `/factory customize` -- or `setup` or `init`; This would customize it for the project it is installed to. So if you have a particular issue tracker that you want to use or or if you have particular rules for the reviewers, this is where it would happen. But this would also put in guardrails so that nothing changes that would affect the orchestration observability. 

# Dashboard

- It'd be nice if the cards for the jobs, when they were in an active life cycle state, like spec, build, review, approve, if there were a little timer that showed how long the job has been in that status. 
- The column headers should be fixed so if I scroll they don't I don't lose them. 
- It'd be nice if we had a settled state for the merged jobs after a certain timeframe probably. (Maybe configurable.) So that would hide them from the merged column, but then we could have a settled view (in a dialog) somewhere that could show all the settled ones so for historical information. That way that merged column won't get massive. 
- Should each column be individually scrollable? 

